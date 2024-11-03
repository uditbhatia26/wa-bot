const { hidePrivateData } = require('./utils')
const makeWASocket = require('@whiskeysockets/baileys').default
const {
    DisconnectReason,
    useMultiFileAuthState

} = require('@whiskeysockets/baileys')

const store = {};
const getMessage = key => {
    const { id } = key
    if (store[id]) return store[id].message;
}

async function WhatsappBot() {

    // For Authentication Purposes
    const { state, saveCreds } = await useMultiFileAuthState("auth")

    // Creating a Socket
    const Sock = makeWASocket({
        printQRInTerminal: true,
        auth: state,
        getMessage // This message is taking to long to receive cause u have not supplied this get msg function, to retrive sending the msgs if there is some issue

    })

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
    }

    const sendMessage = async (jid, content, ...args) => {
        try {
            const sent = await Sock.sendMessage(jid, content, ...args);
            store[sent.key.id] = sent;
        }
        catch (err) {
            console.log("Error Sending msg: ", err);
        }
    }

    const handleMirror = async (msg) => {
        const { key, message } = msg;
        const text = getText(message);

        const prefix = "@jarvis";
        if (!text.startsWith(prefix)) return;

        const reply = text.slice(prefix.length);

        sendMessage(key.remoteJid, { text: reply }, {quoted: msg})
    }

// Tagall
    const handleAll = async (msg) => {
        const { key, message } = msg;
        const text = getText(message);
    
        // Only proceed if the message includes '!tagall'
        if (!text.toLowerCase().includes('!tagall')) return;
    
        // Fetch group metadata to get participants and their roles
        const group = await Sock.groupMetadata(key.remoteJid);
        const members = group.participants;
    
        // Check if the sender is an admin
        const senderId = key.participant || key.remoteJid;  // The ID of the person who sent the message
        const isAdmin = members.some(member => member.id === senderId && member.admin);
    
        if (!isAdmin) {
            // Send a message to the group indicating that only admins can use the command
            await sendMessage(key.remoteJid, { text: "Only admins can use this command!" }, { quoted: msg });
            return;  // Exit if the sender is not an admin
        }
    
        // If sender is an admin, proceed to tag all members
        const mentions = [];
        const items = [];
    
        members.forEach(({ id, admin }) => {
            mentions.push(id);
            items.push(`@${id.slice(0, 12)} ${admin ? "👑" : " "}`);
        });
    
        // Send the message tagging all members
        sendMessage(
            key.remoteJid, 
            { text: items.join(", "), mentions },
            { quoted: msg }
        );
    }
    
    
    Sock.ev.process(async events => {
        if (events['connection.update']) {
            const { connection, lastDisconnect } = events['connection.update']
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
                //MIRROR COMMAND for example - !mirror Hello
                // HELLO 
                // console.log(hidePrivateData(message))
                handleMirror(msg);
                handleAll(msg);
            })
        }
    })
}
WhatsappBot()

// YOUR SOCKET CONNECTION IS READY


