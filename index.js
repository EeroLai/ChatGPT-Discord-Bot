import dotenv from 'dotenv'
import { ChatGPTAPIBrowser } from 'chatgpt'
import { Client, GatewayIntentBits, REST, Routes, Partials, ChannelType, EmbedBuilder } from 'discord.js'
import Conversations from './conversations.js'

const MAX_RESPONSE_CHUNK_LENGTH = 1500
dotenv.config()

const commands = [
    {
        name: '問哥布林',
        description: '問哥布林任何問題!',
        options: [
            {
                name: "問題",
                description: "你的問題",
                type: 3,
                required: true
            }
        ]
    }
]

async function initChatGPT() {
    const api = new ChatGPTAPIBrowser({
        email: process.env.OPENAI_EMAIL,
        password: process.env.OPENAI_PASSWORD,
        isGoogleLogin: process.env.IS_GOOGLE_LOGIN?.toLocaleLowerCase() == "true"
    })

    await api.initSession()

    return {
        sendMessage: (message, opts = {}) => {
            return api.sendMessage(message, opts)
        }
    };
}

async function initDiscordCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

    try {
        console.log('Started refreshing application (/) commands.');
        await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands });
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
}

async function main() {
    const chatGTP = await initChatGPT().catch(e => {
        console.error(e)
        process.exit()
    })

    await initDiscordCommands()

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildIntegrations,
            GatewayIntentBits.DirectMessages,
            GatewayIntentBits.DirectMessageTyping,
            GatewayIntentBits.MessageContent,
        ],
        partials: [Partials.Channel]
    });

    client.on('ready', () => {
        console.log(`Logged in as ${client.user.tag}!`);
        console.log(new Date())
    });

    async function askQuestion(question, cb, opts = {}) {

        const { conversationInfo } = opts

        let tmr = setTimeout(() => {
            cb("Oppss, something went wrong! (Timeout)")
        }, 120000)

        if (process.env.CONVERSATION_START_PROMPT.toLowerCase() != "false" && conversationInfo.newConversation) {
            await chatGTP.sendMessage(process.env.CONVERSATION_START_PROMPT, {
                conversationId: conversationInfo.conversationId,
                parentMessageId: conversationInfo.parentMessageId
            }).then(response => {
                conversationInfo.conversationId = response.conversationId
                conversationInfo.parentMessageId = response.messageId
                clearTimeout(tmr)
                tmr = setTimeout(() => {
                    cb("Oppss, something went wrong! (Timeout)")
                }, 45000)
            }).catch((e) => {
                cb("Oppss, something went wrong! (Error)")
                console.error("dm error : " + e)
            })
        }

        if (conversationInfo) {
            chatGTP.sendMessage(question, {
                conversationId: conversationInfo.conversationId,
                parentMessageId: conversationInfo.parentMessageId
            }).then(response => {
                conversationInfo.conversationId = response.conversationId
                conversationInfo.parentMessageId = response.messageId
                clearTimeout(tmr)
                cb(response.response)
            }).catch((e) => {
                cb("Oppss, something went wrong! (Error)")
                console.error("dm error : " + e)
            })
        } else {
            chatGTP.sendMessage(question).then(({ response }) => {
                //console.log(response)
                clearTimeout(tmr)
                cb(response)
            }).catch((e) => {
                cb("Oppss, something went wrong! (Error)")
                console.error("/問哥布林 error : " + e)
            })
        }
    }

    async function splitAndSendResponse(resp, user) {
        let tryCount = 3;
        while (resp.length > 0 && tryCount > 0) {
            try {
                let end = Math.min(MAX_RESPONSE_CHUNK_LENGTH, resp.length)
                await user.send(resp.slice(0, end))
                resp = resp.slice(end, resp.length)
            } catch (e) {
                tryCount--
                console.error("splitAndSendResponse Error : " + e + " | Counter " + tryCount)
            }
        }

        if (tryCount <= 0) {
            throw "Failed to send dm."
        }
    }

    function createEmbedForAskCommand(user, prompt, response) {

        if (prompt.length >= 250) {
            prompt = prompt.slice(0, 250) + "..."
        }

        const embed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setAuthor({ name: user.username })
            .setTitle(prompt)
            .setDescription(response.slice(0, Math.min(response.length, 4096)))

        if (response.length > 4096) {
            response = response.slice(4096, response.length)
            for (let i = 0; i < 10 && response.length > 0; i++) {
                embed.addFields({
                    name: "",
                    value: response.slice(0, Math.min(response.length, 1024))
                })
                response = response.slice(Math.min(response.length, 1024), response.length)
            }
        }

        return embed
    }

    client.on("messageCreate", async message => {
        if (process.env.ENABLE_DIRECT_MESSAGES !== "true" || message.channel.type != ChannelType.DM || message.author.bot) {
            return;
        }
        const user = message.author

        console.log("----Direct Message---")
        console.log("Date    : " + new Date())
        console.log("UserId  : " + user.id)
        console.log("User    : " + user.username)
        console.log("Message : " + message.content)
        console.log("--------------")

        if (message.content.toLowerCase() == "reset") {
            Conversations.resetConversation(user.id)
            user.send("你是誰 ?")
            return;
        }

        let conversationInfo = Conversations.getConversation(user.id)
        try {
            let sentMessage = await user.send("嗯..., 讓我想想...")
            askQuestion(message.content, async (response) => {
                if (response.length >= MAX_RESPONSE_CHUNK_LENGTH) {
                    splitAndSendResponse(response, user)
                } else {
                    await sentMessage.edit(response)
                }
            }, { conversationInfo })
        } catch (e) {
            console.error(e)
        }
    })

    async function handle_interaction_ask(interaction) {
        const user = interaction.user

        // Begin conversation
        let conversationInfo = Conversations.getConversation(user.id)
        const question = interaction.options.getString("問題")

        if(question.toLowerCase() == "reset"){
            Conversations.resetConversation(user.id)
            const embed = createEmbedForAskCommand(user, question, "你是誰 ?")
            await interaction.reply({ embeds: [embed] })
            return;
        }

        try {
            await interaction.deferReply()
            askQuestion(question, async (content) => {
                const embed = createEmbedForAskCommand(user, question, content)
                interaction.editReply({ embeds: [embed] })
            }, { conversationInfo })
        } catch (e) {
            console.error(e)
        }
    }


    client.on("interactionCreate", async interaction => {
        switch (interaction.commandName) {
            case "問哥布林":
                handle_interaction_ask(interaction)
                break;
        }
    });

    client.login(process.env.DISCORD_BOT_TOKEN);
}

main()