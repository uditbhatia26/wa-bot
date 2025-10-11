import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  getContentType,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import qrcode from "qrcode-terminal";
import express from "express";

const app = express();
const port = 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PREFIX = "!";
const CMD_TAGALL = "tagall";
const DATA_DIR = path.join(__dirname, "data");
const GROUPS_DB = path.join(DATA_DIR, "subgroups.json");

let restarting = false;

/* ----------------- 🔐 OWNER CONFIG ----------------- */
const OWNER_JIDS = [
  "918929676776@s.whatsapp.net", // 🟢 Your WhatsApp number
];

/* ----------------- 🔧 FILE HELPERS ----------------- */
function ensureDataStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(GROUPS_DB))
    fs.writeFileSync(GROUPS_DB, JSON.stringify({}), "utf8");
}

function loadDb() {
  ensureDataStore();
  try {
    const raw = fs.readFileSync(GROUPS_DB, "utf8");
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function saveDb(db) {
  ensureDataStore();
  fs.writeFileSync(GROUPS_DB, JSON.stringify(db, null, 2), "utf8");
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* ----------------- 🧠 MESSAGE HELPERS ----------------- */
function extractNumbersFromText(text) {
  const nums = Array.from(new Set(text.match(/\b\d{8,15}\b/g) || []));
  return nums.map((n) => `${n}@s.whatsapp.net`);
}

async function extractMentionedJids(msg, sock, meta) {
  const type = getContentType(msg.message);
  let contextInfo;

  if (type === "extendedTextMessage") {
    contextInfo = msg.message.extendedTextMessage.contextInfo;
  } else if (type === "conversation") {
    contextInfo = {};
  } else {
    const inner = msg.message[type];
    contextInfo = inner?.contextInfo || {};
  }

  const groupIds = new Set((meta?.participants || []).map((p) => p.id));
  let jids = Array.isArray(contextInfo?.mentionedJid)
    ? [...contextInfo.mentionedJid]
    : [];

  const resolved = [];
  for (const id of jids) {
    if (id.endsWith("@lid")) {
      const num = id.replace("@lid", "");
      // Try to resolve via group members
      const match = (meta.participants || []).find((p) => p.id.includes(num));
      if (match?.id) resolved.push(match.id);
      else console.log("⚠️ Could not resolve LID:", id);
    } else resolved.push(id);
  }

  if (resolved.length === 0 && contextInfo?.participant) {
    const candidate = contextInfo.participant;
    if (groupIds.has(candidate)) resolved.push(candidate);
  }

  return Array.from(new Set(resolved)).filter((j) => groupIds.has(j));
}

/* ----------------- 👤 SELF-JID HELPERS ----------------- */
function normalizeJid(jid = "") {
  const match = jid.match(/(\d{6,15})/);
  return match ? match[1] : "";
}

function getSelfJid(sock) {
  return normalizeJid(sock?.user?.id || sock?.user?.jid || "");
}

function getQuotedMessage(msg) {
  const type = getContentType(msg.message);
  const ctx =
    msg.message?.[type]?.contextInfo ||
    msg.message?.extendedTextMessage?.contextInfo;

  if (!ctx?.quotedMessage) return null;

  return {
    key: {
      remoteJid: msg.key.remoteJid,
      fromMe: false,
      id: ctx.stanzaId,
      participant: ctx.participant || ctx.remoteJid,
    },
    message: ctx.quotedMessage,
  };
}

/* ----------------- 🧩 BOT START ----------------- */
async function startBot(backoffMs = 1000) {
  try {
    const authPath = path.join(__dirname, "auth_info");
    if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const sock = makeWASocket({ auth: state });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        console.log("📱 Scan this QR to connect your WhatsApp:");
        qrcode.generate(qr, { small: true });
      }

      if (connection === "open") {
        console.log("✅ Bot connected and ready!");
        restarting = false;
      } else if (connection === "close") {
        const err = lastDisconnect?.error;
        const statusCode =
          (err instanceof Boom && err.output?.statusCode) ||
          err?.output?.statusCode ||
          err?.statusCode;

        const loggedOut = statusCode === DisconnectReason.loggedOut;
        const shouldReconnect = !loggedOut;
        console.log("❌ Disconnected.", { statusCode, loggedOut });

        if (shouldReconnect && !restarting) {
          restarting = true;
          const nextBackoff = Math.min(backoffMs * 2, 30000);
          setTimeout(
            () => startBot(nextBackoff).catch(console.error),
            backoffMs
          );
        } else if (loggedOut) {
          console.error(
            "🔒 Logged out. Delete auth_info folder to re-authenticate."
          );
        }
      }
    });

    /* ----------------- 📩 MESSAGE HANDLER ----------------- */
    sock.ev.on("messages.upsert", async (upsert) => {
      try {
        const msg = upsert.messages?.[0];
        if (!msg || !msg.message) return;

        const remoteJid = msg.key.remoteJid;
        const isGroup = remoteJid.endsWith("@g.us");
        const sender = msg.key.participant || msg.key.remoteJid;
        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          "";
        const trimmed = text.trim();
        if (!trimmed.startsWith(PREFIX)) return;

        const withoutPrefix = trimmed.slice(PREFIX.length).trim();
        const [cmdRaw, ...args] = withoutPrefix.split(/\s+/);
        const cmd = (cmdRaw || "").toLowerCase();

        const db = loadDb();
        const groupKey = isGroup ? remoteJid : "global";
        if (!db[groupKey]) db[groupKey] = {};

        /* 🧩 DM PERMISSION CHECK */
        if (!isGroup && !OWNER_JIDS.includes(sender)) {
          console.log(`❌ Ignored DM from unauthorized user: ${sender}`);
          return;
        }

        /* ----------------- !tagall ----------------- */
        if (cmd === CMD_TAGALL && isGroup) {
          const meta = await sock.groupMetadata(remoteJid);
          const selfDigits = getSelfJid(sock);
          const members = meta.participants
            .map((p) => p.jid || p.id) // ✅ Prefer the real JID if available
            .filter(Boolean)
            .filter((jid) => normalizeJid(jid) !== selfDigits);

          const chunks = chunkArray(members, 20);
          for (const chunk of chunks) {
            const tagMessage = chunk
              .map((m) => `@${m.split("@")[0]}`)
              .join(" ");
            const quoted = getQuotedMessage(msg);
            await sock.sendMessage(
              remoteJid,
              { text: tagMessage, mentions: chunk },
              quoted ? { quoted } : {}
            );
            await new Promise((r) => setTimeout(r, 400));
          }
          return;
        }

        /* ----------------- !group ----------------- */
        if (cmd === "group") {
          const subcmd = (args.shift() || "").toLowerCase();

          // Help for group command
          if (!subcmd) {
            await sock.sendMessage(remoteJid, {
              text: `🧩 *Subgroup Commands*
• !group add <name> <numbers or @mentions>
• !group remove <name> <numbers or @mentions>
• !group show <name>
• !group list
• !group delete <name>`,
            });
            return;
          }

          // Manage permissions: only owners can edit
          if (!OWNER_JIDS.includes(sender)) {
            await sock.sendMessage(remoteJid, {
              text: "🚫 You don’t have permission to manage subgroups.",
            });
            return;
          }

          /* !group list */
          if (subcmd === "list") {
            const names = Object.keys(db[groupKey]);
            const lines = names.length
              ? names
                  .map((n) => `• *${n}* (${db[groupKey][n].length})`)
                  .join("\n")
              : "_No subgroups yet._";
            await sock.sendMessage(remoteJid, {
              text: `🧩 *${
                groupKey === "global" ? "Global" : "Group"
              } Subgroups*\n${lines}`,
            });
            return;
          }

          /* !group show <name> */
          if (subcmd === "show") {
            const name = (args.shift() || "").toLowerCase();
            const list = db[groupKey][name] || [];
            if (!list.length) {
              await sock.sendMessage(remoteJid, {
                text: `No members in *${name}*.`,
              });
              return;
            }
            const txt = list.map((j) => `@${j.split("@")[0]}`).join(" ");
            await sock.sendMessage(remoteJid, {
              text: `👥 *${name}* (${list.length})\n${txt}`,
              mentions: list,
            });
            return;
          }

          /* !group delete <name> */
          if (subcmd === "delete") {
            const name = (args.shift() || "").toLowerCase();
            delete db[groupKey][name];
            saveDb(db);
            await sock.sendMessage(remoteJid, {
              text: `🗑️ Deleted subgroup *${name}*.`,
            });
            return;
          }

          /* !group add/remove */
          if (["add", "remove"].includes(subcmd)) {
            const name = (args.shift() || "").toLowerCase();
            let mentions = [];
            if (isGroup) {
              const meta = await sock.groupMetadata(remoteJid);
              mentions = await extractMentionedJids(msg, sock, meta);
            } else {
              mentions = extractNumbersFromText(text);
            }

            if (!mentions.length) {
              await sock.sendMessage(remoteJid, {
                text: "No valid members found. Mention in group or use numbers in DM.",
              });
              return;
            }

            if (!db[groupKey][name]) db[groupKey][name] = [];
            const set = new Set(db[groupKey][name]);
            if (subcmd === "add") mentions.forEach((j) => set.add(j));
            else mentions.forEach((j) => set.delete(j));

            db[groupKey][name] = Array.from(set);
            saveDb(db);
            await sock.sendMessage(remoteJid, {
              text: `✅ Updated *${name}* (${db[groupKey][name].length} members).`,
            });
            return;
          }
        }

        /* ----------------- !tag<name> (only tag members present in THIS group) ----------------- */
        if (cmd.startsWith("tag") && cmd !== CMD_TAGALL) {
          const name = cmd.slice(3).toLowerCase();

          // 1) Fetch saved subgroup list (group-local first, then global fallback)
          const rawList = db[remoteJid]?.[name] || db.global?.[name] || [];
          if (!rawList.length) {
            await sock.sendMessage(remoteJid, {
              text: `No members in subgroup *${name}*.`,
            });
            return;
          }

          // 2) Build a map of current group's participants -> normalized digits
          const meta = await sock.groupMetadata(remoteJid);
          const selfDigits = getSelfJid(sock);

          const presentMap = new Map(); // digits -> actual JID in this group
          for (const p of meta.participants || []) {
            const jid = p?.jid || p?.id;
            const d = normalizeJid(jid);
            if (d && d !== selfDigits) presentMap.set(d, jid);
          }

          // 3) Intersect subgroup members with present participants
          const finalMentions = [];
          for (const j of rawList) {
            const d = normalizeJid(j);
            const mapped = d && presentMap.get(d);
            if (mapped) finalMentions.push(mapped);
          }

          // 4) Dedupe and send
          const mentions = Array.from(new Set(finalMentions));
          if (!mentions.length) {
            await sock.sendMessage(remoteJid, {
              text: `No members of subgroup *${name}* are present in this group.`,
            });
            return;
          }

          const chunks = chunkArray(mentions, 20);
          for (const chunk of chunks) {
            const msgText = chunk.map((m) => `@${m.split("@")[0]}`).join(" ");
            const quoted = getQuotedMessage(msg);
            await sock.sendMessage(
              remoteJid,
              { text: msgText, mentions: chunk },
              quoted ? { quoted } : {}
            );
            await new Promise((r) => setTimeout(r, 400));
          }
          return;
        }

        /* ----------------- !arnav bhai ----------------- */
        if (trimmed.toLowerCase() === "!arnav bhai") {
          try {
            // Path to your sticker (must be in .webp format)
            const stickerPath = path.join(__dirname, "stickers", "arnav.webp");

            if (!fs.existsSync(stickerPath)) {
              await sock.sendMessage(remoteJid, {
                text: "⚠️ Sticker not found! Please add `arnav.webp` in /stickers folder.",
              });
              return;
            }

            const stickerBuffer = fs.readFileSync(stickerPath);

            await sock.sendMessage(remoteJid, {
              sticker: stickerBuffer,
            });
          } catch (err) {
            console.error("💥 Error sending sticker:", err);
          }
          return;
        }

        /* ----------------- !help ----------------- */
        if (cmd === "help") {
          await sock.sendMessage(remoteJid, {
            text: `🛠️ *Available Commands*
• !tagall — tag everyone (group)
• !tag<name> — tag subgroup
• !group add/remove/show/list/delete — manage subgroups (only owner in DM)`,
          });
        }
      } catch (err) {
        console.error("💥 Message handler error:", err);
      }
    });
  } catch (err) {
    console.error("Fatal startBot error:", err);
    if (!restarting) {
      restarting = true;
      setTimeout(
        () => startBot(Math.min(backoffMs * 2, 30000)).catch(console.error),
        backoffMs
      );
    }
  }
}

startBot().catch(console.error);

// 🔴 this is REQUIRED for Render
app.get("/", (req, res) => {
  res.send("WhatsApp Bot is running 🚀");
});

app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});