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
import { fetchLatestBaileysVersion } from "@whiskeysockets/baileys";

// LangChain + Groq
import { ChatGroq } from "@langchain/groq";
import { PromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence } from "@langchain/core/runnables";
import { StringOutputParser } from "@langchain/core/output_parsers";

// Groq LLM via LangChain
const lcModel = new ChatGroq({
  model: "llama-3.3-70b-versatile",
  temperature: 0.3,
  apiKey: process.env.GROQ_API_KEY,
});

// Summarization chain
const summarizePrompt = PromptTemplate.fromTemplate(
  `You are a concise WhatsApp chat summarizer.
Summarize the following {k} most recent messages.
- Be brief, structured, and neutral.
- Use bullet points.
- Add short action items if obvious.
Messages:
{messages}`
);

const summarizeChain = RunnableSequence.from([
  summarizePrompt,
  lcModel,
  new StringOutputParser(),
]);

const app = express();
const port = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PREFIX = "!";
const CMD_TAGALL = "tagall";
const DATA_DIR = path.join(__dirname, "data");
const GROUPS_DB = path.join(DATA_DIR, "subgroups.json");

let restarting = false;

/* ----------------- 🔐 OWNER CONFIG ----------------- */
const OWNER_JIDS = [
  "919717228929@s.whatsapp.net",
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

/* ----------------- 💾 ROLLING CHAT BUFFER ----------------- */
const MAX_BUFFER_PER_CHAT = 200;
const chatBuffers = new Map(); // remoteJid -> [{ from, text, ts }]

function addToChatBuffer(remoteJid, entry) {
  if (!entry?.text) return;
  const arr = chatBuffers.get(remoteJid) || [];
  arr.push(entry);
  if (arr.length > MAX_BUFFER_PER_CHAT) {
    arr.splice(0, arr.length - MAX_BUFFER_PER_CHAT);
  }
  chatBuffers.set(remoteJid, arr);
}

function getRecentMessages(remoteJid, k) {
  const arr = chatBuffers.get(remoteJid) || [];
  return arr.slice(-k);
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

  const groupIds = new Set((meta?.participants || []).map((p) => p.id || p.jid));
  let jids = Array.isArray(contextInfo?.mentionedJid)
    ? [...contextInfo.mentionedJid]
    : [];

  const resolved = [];
  for (const id of jids) {
    if (id.endsWith("@lid")) {
      const num = id.replace("@lid", "");
      const match = (meta.participants || []).find(
        (p) => (p.id || p.jid)?.includes(num)
      );
      if (match?.id || match?.jid) resolved.push(match.id || match.jid);
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

/* ----------------- 🛡️ PERMISSIONS ----------------- */
async function isAdmin(sock, remoteJid, sender) {
  try {
    const meta = await sock.groupMetadata(remoteJid);
    const p = (meta.participants || []).find(
      (x) => (x.id || x.jid) === sender
    );
    return p?.admin === "admin" || p?.admin === "superadmin";
  } catch (e) {
    console.warn("isAdmin() failed to fetch group metadata:", e?.message);
    return false;
  }
}

/* ----------------- 🧩 BOT START ----------------- */
async function startBot(backoffMs = 1000) {
  try {
    const authPath = path.join(__dirname, "auth_info");
    if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      browser: ["Ubuntu", "Chrome", "22.04.4"],
    });

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

        // ✅ buffer messages so summarize works
        if (trimmed) {
          addToChatBuffer(remoteJid, {
            from: sender,
            text: trimmed,
            ts: Date.now(),
          });
        }

        if (!trimmed.startsWith(PREFIX)) return;

        const withoutPrefix = trimmed.slice(PREFIX.length).trim();
        const [cmdRaw, ...args] = withoutPrefix.split(/\s+/);
        const cmd = (cmdRaw || "").toLowerCase();

        const db = loadDb();
        const groupKey = isGroup ? remoteJid : "global";
        if (!db[groupKey]) db[groupKey] = {};

        /* 🧩 DM PERMISSION CHECK (keep owner-only in DMs) */
        if (!isGroup && !OWNER_JIDS.includes(sender)) {
          console.log(`❌ Ignored DM from unauthorized user: ${sender}`);
          return;
        }

        /* ----------------- !tagall (Admins or Owners only) ----------------- */
        if (cmd === CMD_TAGALL && isGroup) {
          const isOwner = OWNER_JIDS.includes(sender);
          const isGrpAdmin = await isAdmin(sock, remoteJid, sender);
          if (!isOwner && !isGrpAdmin) {
            await sock.sendMessage(remoteJid, {
              text: "🚫 Only group admins can use !tagall.",
            });
            return;
          }

          const meta = await sock.groupMetadata(remoteJid);
          const selfDigits = getSelfJid(sock);
          const members = meta.participants
            .map((p) => p.jid || p.id)
            .filter(Boolean)
            .filter((jid) => normalizeJid(jid) !== selfDigits);

          const chunks = chunkArray(members, 20);
          for (const chunk of chunks) {
            const tagMessage = chunk.map((m) => `@${m.split("@")[0]}`).join(" ");
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

        /* ----------------- !group (updated permissions & behavior) ----------------- */
        if (cmd === "group") {
          const subcmd = (args.shift() || "").toLowerCase();

          if (!subcmd) {
            await sock.sendMessage(remoteJid, {
              text: `🧩 *Subgroup Commands*
• !group create <name> — create a new subgroup (admin/owner)
• !group add <name> <@mentions or numbers> — add members (anyone in group)
• !group remove <name> <@mentions or numbers> — remove members (admin/owner)
• !group tag <name> <@mentions or numbers> — tag members (admin/owner)
• !group list — list subgroups (anyone)
• !group delete <name> — delete subgroup (admin/owner)`,
            });
            return;
          }

          const isOwner = OWNER_JIDS.includes(sender);
          const isGrpAdmin = isGroup ? await isAdmin(sock, remoteJid, sender) : false;

          // Permissions per subcommand
          if (subcmd === "create" || subcmd === "delete" || subcmd === "remove") {
            if (!isGrpAdmin) {
              await sock.sendMessage(remoteJid, {
                text: "🚫 Only group admins can perform this action.",
              });
              return;
            }
          }
          // "add" is open to everyone in the group (DM still restricted above)
          // "list" and "show" are open to everyone

          /* !group list (anyone) */
          if (subcmd === "list") {
            const names = Object.keys(db[groupKey]);
            const lines = names.length
              ? names.map((n) => `• *${n}* (${db[groupKey][n].length})`).join("\n")
              : "_No subgroups yet._";
            await sock.sendMessage(remoteJid, {
              text: `🧩 *${groupKey === "global" ? "Global" : "Group"} Subgroups*\n${lines}`,
            });
            return;
          }

          /* !group tag <name> (anyone) */
          if (subcmd === "tag") {
            if (!isGrpAdmin) {

            }
            else {
              const name = (args.shift() || "").toLowerCase();
              const list = db[groupKey][name] || [];
              if (!name) {
                await sock.sendMessage(remoteJid, { text: "Usage: !group tag <name>" });
                return;
              }
              if (!list.length) {
                await sock.sendMessage(remoteJid, { text: `No members in *${name}*.` });
                return;
              }
              const txt = list.map((j) => `@${j.split("@")[0]}`).join(" ");
              await sock.sendMessage(remoteJid, {
                text: `Tagging *${name}* (${list.length})\n${txt}`,
                mentions: list,
              });
              return;
            }

          }


          /* !group show <name> (anyone) */
          if (subcmd === "show") {
            const name = (args.shift() || "").toLowerCase();
            const list = db[groupKey][name] || [];
            if (!name) {
              await sock.sendMessage(remoteJid, { text: "Usage: !group show <name>" });
              return;
            }
            if (!list.length) {
              await sock.sendMessage(remoteJid, { text: `No members in *${name}*.` });
              return;
            }
            const txt = list.map((j) => `@${j.split("@")[0]}`).join(" ");
            await sock.sendMessage(remoteJid, {
              text: `👥 Members in *${name}* (${list.length})\n${txt}`,
              mentions: list,
            });
            return;
          }

          /* !group create <name> (admin/owner) */
          if (subcmd === "create") {
            const name = (args.shift() || "").toLowerCase();
            if (!name) {
              await sock.sendMessage(remoteJid, { text: "Usage: !group create <name>" });
              return;
            }
            if (db[groupKey][name]) {
              await sock.sendMessage(remoteJid, { text: `⚠️ Subgroup *${name}* already exists.` });
              return;
            }
            db[groupKey][name] = [];
            saveDb(db);
            await sock.sendMessage(remoteJid, { text: `✅ Created subgroup *${name}*.` });
            return;
          }

          /* !group delete <name> (admin/owner) */
          if (subcmd === "delete") {
            const name = (args.shift() || "").toLowerCase();
            if (!db[groupKey][name]) {
              await sock.sendMessage(remoteJid, { text: `No such subgroup *${name}*.` });
              return;
            }
            delete db[groupKey][name];
            saveDb(db);
            await sock.sendMessage(remoteJid, { text: `🗑️ Deleted subgroup *${name}*.` });
            return;
          }

          /* !group add/remove */
          if (["add", "remove"].includes(subcmd)) {
            const name = (args.shift() || "").toLowerCase();
            if (!name) {
              await sock.sendMessage(remoteJid, { text: `Usage: !group ${subcmd} <name> <@mentions or numbers>` });
              return;
            }

            // For "add": subgroup MUST already exist (no implicit create)
            if (subcmd === "add" && !db[groupKey][name]) {
              await sock.sendMessage(remoteJid, {
                text: `⚠️ Subgroup *${name}* does not exist. Ask an admin to run *!group create ${name}* first.`,
              });
              return;
            }

            // For "remove": also require subgroup exists
            if (subcmd === "remove" && !db[groupKey][name]) {
              await sock.sendMessage(remoteJid, { text: `No such subgroup *${name}*.` });
              return;
            }

            let mentions = [];
            if (isGroup) {
              const meta = await sock.groupMetadata(remoteJid);
              mentions = await extractMentionedJids(msg, sock, meta);

              // ✅ Self-add: if user didn't mention anyone and this is an ADD in a group, add the sender
              if (subcmd === "add" && mentions.length === 0) {
                mentions = [sender];
              }
            } else {
              // In DMs (already owner-only), allow numbers
              mentions = extractNumbersFromText(text);
            }

            if (!mentions.length) {
              await sock.sendMessage(remoteJid, {
                text: "No valid members found. In a group, use @mentions or just run “!group add <name>” to add yourself. In DM, provide numbers.",
              });
              return;
            }


            const set = new Set(db[groupKey][name] || []);
            if (subcmd === "add") mentions.forEach((j) => set.add(j));
            else mentions.forEach((j) => set.delete(j));

            db[groupKey][name] = Array.from(set);
            saveDb(db);

            await sock.sendMessage(remoteJid, {
              text: `✅ ${subcmd === "add" ? "Added to" : "Updated"} *${name}* (${db[groupKey][name].length} members).`,
            });
            return;
          }

          // Unknown subcommand
          await sock.sendMessage(remoteJid, { text: "Unknown subcommand. Type !group for help." });
          return;
        }

        /* ----------------- fun sticker ----------------- */
        if (trimmed.toLowerCase() === "!naman summon") {
          try {
            const stickerPath = path.join(__dirname, "stickers", "naman.webp");
            if (!fs.existsSync(stickerPath)) {
              await sock.sendMessage(remoteJid, {
                text: "⚠️ Sticker not found! Please add `naman.webp` in /stickers folder.",
              });
              return;
            }
            const stickerBuffer = fs.readFileSync(stickerPath);
            await sock.sendMessage(remoteJid, { sticker: stickerBuffer });
          } catch (err) {
            console.error("💥 Error sending sticker:", err);
          }
          return;
        }

        /* ----------------- !summarize <k> (Everyone in group) ----------------- */
        if (cmd === "summarize") {
          if (!isGroup) {
            await sock.sendMessage(remoteJid, {
              text: "This command works in groups only.",
            });
            return;
          }

          let kRaw = args.shift();
          let k = parseInt(kRaw ?? "20", 10);
          if (!Number.isFinite(k) || k <= 0) k = 20;
          if (k > 100) k = 100;

          const recent = getRecentMessages(remoteJid, k);
          if (!recent.length) {
            await sock.sendMessage(remoteJid, {
              text: "No cached messages to summarize yet.",
            });
            return;
          }

          const formatted = recent
            .map((m) => `- ${m.from.replace("@s.whatsapp.net", "")}: ${m.text}`)
            .join("\n");

          if (!process.env.GROQ_API_KEY) {
            await sock.sendMessage(remoteJid, {
              text: "⚠️ Summarizer not configured. Set GROQ_API_KEY in environment.",
            });
            return;
          }

          try {
            const summary = await summarizeChain.invoke({
              k: recent.length,
              messages: formatted,
            });
            await sock.sendMessage(remoteJid, {
              text: `📝 *Summary of last ${recent.length} messages:*\n${summary}`,
            });
          } catch (e) {
            console.error("Summarize error:", e);
            await sock.sendMessage(remoteJid, {
              text: "❌ Failed to summarize messages.",
            });
          }
          return;
        }

        /* ----------------- !help ----------------- */
        if (cmd === "help") {
          await sock.sendMessage(remoteJid, {
            text: `🛠️ *Available Commands*
• !group create <name> — create subgroup (admin/owner)
• !group add <name> <members> — add to subgroup (anyone in group)
• !group remove <name> <members> — remove from subgroup (admin/owner)
• !group show <name> — view subgroup members (anyone)
• !group list — list subgroups (anyone)
• !group delete <name> — delete subgroup (admin/owner)
• !group tag <name> — tag subgroup (admins/owners only)
• !tagall — tag everyone (admin/owner)
• !summarize <k> — summarize last k (≤100) messages (anyone in group)`,
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
