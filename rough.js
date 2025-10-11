const { hidePrivateData } = require('./utils');
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
    DisconnectReason,
    useMultiFileAuthState
} = require('@whiskeysockets/baileys');
const axios = require('axios'); // Added to handle API requests

const store = {};
const getMessage = key => {
    const { id } = key;
    if (store[id]) return store[id].message;
};

const GOOGLE_API_KEY = "AIzaSyBW2nM1MUcYIj04d5Z313SQ7_5aCsWxxuc"; // Your API Key
const LLM_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=GEMINI_API_KEY"; // Example URL for Google's Gemini (adjust if necessary)

async function WhatsappBot() {

    // For Authentication Purposes
    const { state, saveCreds } = await useMultiFileAuthState("auth");

    // Creating a Socket
    const Sock = makeWASocket({
        printQRInTerminal: true,
        auth: state,
        getMessage // This message is taking too long to receive because you have not supplied this get message function to retrieve sending messages if there is an issue
    });

    // GETTING TEXT MESSAGE FROM BOT
    const getText = message => {
        try {
            return (
                message.conversation || message.extendedTextMessage.text
            );
        }
        catch {
            return " ";
        }
    };

    const sendMessage = async (jid, content, ...args) => {
        try {
            const sent = await Sock.sendMessage(jid, content, ...args);
            store[sent.key.id] = sent;
        }
        catch (err) {
            console.log("Error Sending msg: ", err);
        }
    };

    const handleMirror = async (msg) => {
        const { key, message } = msg;
        const text = getText(message);

        const prefix = "@jarvis";
        if (!text.startsWith(prefix)) return;

        const reply = text.slice(prefix.length);

        sendMessage(key.remoteJid, { text: reply }, { quoted: msg });
    };

    // Tagall
    const handleAll = async (msg) => {
        const { key, message } = msg;
        const text = getText(message);

        if (!text.toLowerCase().includes('!tagall')) return;

        const group = await Sock.groupMetadata(key.remoteJid);
        const members = group.participants;

        const senderId = key.participant || key.remoteJid;
        const isAdmin = members.some(member => member.id === senderId && member.admin);

        if (!isAdmin) {
            await sendMessage(key.remoteJid, { text: "Only admins can use this command!" }, { quoted: msg });
            return;
        }

        const mentions = [];
        const items = [];

        members.forEach(({ id, admin }) => {
            mentions.push(id);
            items.push(`@${id.slice(0, 12)} ${admin ? "👑" : " "}`);
        });

        sendMessage(
            key.remoteJid,
            { text: items.join(", "), mentions },
            { quoted: msg }
        );
    };

    // Handle !ask Command
    const handleAsk = async (msg) => {
        const { key, message } = msg;
        const text = getText(message);
    
        if (!text.toLowerCase().startsWith('!ask ')) return;
    
        const query = text.slice(5).trim(); // Extract query after '!ask'
    
        try {
            const response = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GOOGLE_API_KEY}`,
                {
                    contents: [
                        {
                            parts: [{ text: query }]
                        }
                    ]
                },
                {
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );
    
            console.log("API Response:", response.data);  // Log the response
    
            // Extracting the generated content from the response
            const reply = response.data.candidates?.[0]?.content?.[0]?.text || "Sorry, I couldn't generate a response.";
            await sendMessage(key.remoteJid, { text: reply }, { quoted: msg });
        } catch (error) {
            console.error("Error with !ask command:", error.response?.data || error.message);
            const errorMessage = error.response?.data?.error?.message || "An unknown error occurred.";
            await sendMessage(key.remoteJid, { text: `Error: ${errorMessage}` }, { quoted: msg });
        }
    };
    
    
    

    Sock.ev.process(async events => {
        if (events['connection.update']) {
            const { connection, lastDisconnect } = events['connection.update'];
            if (connection === 'close') {
                if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                    WhatsappBot();
                } else {
                    console.log("Disconnected because you logged out");
                }
            }
        }

        if (events['creds.update']) {
            await saveCreds();
        }

        if (events["messages.upsert"]) {
            const { messages } = events["messages.upsert"];
            messages.forEach(msg => {
                if (!msg.message) return;
                handleMirror(msg);
                handleAll(msg);
                handleAsk(msg); // Add the !ask handler
            });
        }
    });
}
WhatsappBot();

// YOUR SOCKET CONNECTION IS READY
