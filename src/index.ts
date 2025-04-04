/* eslint-disable no-underscore-dangle */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { PostgresDatabaseAdapter } from '@elizaos/adapter-postgres';
import { SqliteDatabaseAdapter } from '@elizaos/adapter-sqlite';
import { AutoClientInterface } from '@elizaos/client-auto';
import { DirectClient } from '@elizaos/client-direct';
import { DiscordClientInterface } from '@elizaos/client-discord';
import { TelegramClientInterface } from '@elizaos/client-telegram';
import {
    DbCacheAdapter,
    defaultCharacter,
    ICacheManager,
    IDatabaseCacheAdapter,
    stringToUuid,
    AgentRuntime,
    CacheManager,
    Character,
    IAgentRuntime,
    ModelProviderName,
    elizaLogger,
    settings,
    IDatabaseAdapter,
    validateCharacterConfig
} from '@elizaos/core';
import { bootstrapPlugin } from '@elizaos/plugin-bootstrap';
import { createNodePlugin } from '@elizaos/plugin-node';
import Database from 'better-sqlite3';
import yargs from 'yargs';

import { TwitterClientInterface } from './client/twitter/0.1.7/index.ts';
import tokimonsterPlugin from './plugin/index.ts';
import tokimonsterNotification from './util/notification.ts';

const __filename = fileURLToPath(import.meta.url); // get the resolved path to the file
const __dirname = path.dirname(__filename); // get the name of the directory

export const wait = (minTime = 1000, maxTime = 3000) => {
    const waitTime =
        Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;

    return new Promise(resolve => setTimeout(resolve, waitTime));
};

export function parseArguments(): {
    character?: string;
    characters?: string;
} {
    try {
        return yargs(process.argv.slice(2))
            .option('character', {
                type: 'string',
                description: 'Path to the character JSON file',
            })
            .option('characters', {
                type: 'string',
                description: 'Comma separated list of paths to character JSON files',
            })
            .parseSync();
    } catch (error) {
        console.error('Error parsing arguments:', error);

        return {};
    }
}

export async function loadCharacters(
    charactersArg: string
): Promise<Character[]> {
    const characterPaths = charactersArg?.split(',').map(filePath => {
        if (path.basename(filePath) === filePath) {
            filePath = '../characters/' + filePath;
        }

        return path.resolve(process.cwd(), filePath.trim());
    });

    const loadedCharacters = [];

    if (characterPaths?.length > 0) {
        for (const path of characterPaths) {
            try {
                const character = JSON.parse(fs.readFileSync(path, 'utf8'));

                validateCharacterConfig(character);

                loadedCharacters.push(character);
            } catch (e) {
                console.error(`Error loading character from ${path}: ${e}`);
                // don't continue to load if a specified file is not found
                process.exit(1);
            }
        }
    }

    if (loadedCharacters.length === 0) {
        console.log('No characters found, using default character');
        loadedCharacters.push(defaultCharacter);
    }

    return loadedCharacters;
}

export function getTokenForProvider(
    provider: ModelProviderName,
    character: Character
) {
    switch (provider) {
        case ModelProviderName.OPENAI:
            return (
                character.settings?.secrets?.OPENAI_API_KEY || settings.OPENAI_API_KEY
            );
        case ModelProviderName.LLAMACLOUD:
            return (
                character.settings?.secrets?.LLAMACLOUD_API_KEY ||
                settings.LLAMACLOUD_API_KEY ||
                character.settings?.secrets?.TOGETHER_API_KEY ||
                settings.TOGETHER_API_KEY ||
                character.settings?.secrets?.XAI_API_KEY ||
                settings.XAI_API_KEY ||
                character.settings?.secrets?.OPENAI_API_KEY ||
                settings.OPENAI_API_KEY
            );
        case ModelProviderName.ANTHROPIC:
            return (
                character.settings?.secrets?.ANTHROPIC_API_KEY ||
                character.settings?.secrets?.CLAUDE_API_KEY ||
                settings.ANTHROPIC_API_KEY ||
                settings.CLAUDE_API_KEY
            );
        case ModelProviderName.REDPILL:
            return (
                character.settings?.secrets?.REDPILL_API_KEY || settings.REDPILL_API_KEY
            );
        case ModelProviderName.OPENROUTER:
            return (
                character.settings?.secrets?.OPENROUTER || settings.OPENROUTER_API_KEY
            );
        case ModelProviderName.GROK:
            return character.settings?.secrets?.GROK_API_KEY || settings.GROK_API_KEY;
        case ModelProviderName.HEURIST:
            return (
                character.settings?.secrets?.HEURIST_API_KEY || settings.HEURIST_API_KEY
            );
        case ModelProviderName.GROQ:
            return character.settings?.secrets?.GROQ_API_KEY || settings.GROQ_API_KEY;
    }
}

function initializeDatabase(dataDir: string) {
    if (process.env.POSTGRES_URL) {
        const db = new PostgresDatabaseAdapter({
            connectionString: process.env.POSTGRES_URL,
        });

        return db;
    } else {
        const filePath =
            process.env.SQLITE_FILE ?? path.resolve(dataDir, 'db.sqlite');
        // ":memory:";
        const db = new SqliteDatabaseAdapter(new Database(filePath));

        return db;
    }
}

export async function initializeClients(
    character: Character,
    runtime: IAgentRuntime
) {
    const clients = [];
    const clientTypes = character.clients?.map(str => str.toLowerCase()) || [];

    if (clientTypes.includes('auto')) {
        const autoClient = await AutoClientInterface.start(runtime);
        if (autoClient) clients.push(autoClient);
    }

    if (clientTypes.includes('discord')) {
        const discordClient = await DiscordClientInterface.start(runtime);
        if (discordClient) clients.push(discordClient);
    }

    if (clientTypes.includes('telegram')) {
        const telegramClient = await TelegramClientInterface.start(runtime);
        if (telegramClient) clients.push(telegramClient);
    }

    if (clientTypes.includes('twitter')) {
        const twitterClient = await TwitterClientInterface.start(runtime);
        if (twitterClient) clients.push(twitterClient);
    }

    if (character.plugins?.length > 0) {
        for (const plugin of character.plugins) {
            if (plugin.clients) {
                for (const client of plugin.clients) {
                    clients.push(await client.start(runtime));
                }
            }
        }
    }

    return clients;
}

let nodePlugin: any | undefined;

export function createAgent(
    character: Character,
    db: IDatabaseAdapter,
    cache: ICacheManager,
    token: string
) {
    elizaLogger.success(
        elizaLogger.successesTitle,
        'Creating runtime for character',
        character.name
    );

    nodePlugin ??= createNodePlugin();

    return new AgentRuntime({
        databaseAdapter: db,
        token,
        modelProvider: character.modelProvider,
        evaluators: [],
        character,
        plugins: [
            bootstrapPlugin,
            nodePlugin,
            tokimonsterPlugin
        ].filter(Boolean),
        providers: [],
        actions: [],
        services: [],
        managers: [],
        cacheManager: cache,
    });
}

function intializeDbCache(character: Character, db: IDatabaseCacheAdapter) {
    const cache = new CacheManager(new DbCacheAdapter(db, character.id));

    return cache;
}

async function startAgent(character: Character, directClient: DirectClient) {
    try {
        character.id ??= stringToUuid(character.name);
        character.username ??= character.name;

        const token = getTokenForProvider(character.modelProvider, character);
        const dataDir = path.join(__dirname, '../data');

        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        const db = initializeDatabase(dataDir);

        await db.init();

        const cache = intializeDbCache(character, db);
        const runtime = createAgent(character, db, cache, token);

        await runtime.initialize();

        runtime.clients = await initializeClients(character, runtime);

        directClient.registerAgent(runtime);

        return runtime;
    } catch (error) {
        elizaLogger.error(
            `Error starting agent for character ${character.name}:`,
            error
        );
        console.error(error);
        tokimonsterNotification.error(`[Tokimonster] Error starting agent for character ${character.name}`);
        throw error;
    }
}

const startAgents = async () => {
    const directClient = new DirectClient();
    const serverPort = parseInt(settings.SERVER_PORT || '3000');
    const args = parseArguments();

    const charactersArg = args.characters || args.character;

    let characters = [defaultCharacter];

    if (charactersArg) {
        characters = await loadCharacters(charactersArg);
    }

    try {
        for (const character of characters) {
            await startAgent(character, directClient);
        }
    } catch (error) {
        elizaLogger.error('Error starting agents:', error);
    }

    // upload some agent functionality into directClient
    directClient.startAgent = async (character: Character) => {
        // wrap it so we don't have to inject directClient later
        return startAgent(character, directClient);
    };

    directClient.start(serverPort);

    elizaLogger.info(
        'Run `pnpm start:client` to start the client and visit the outputted URL (http://localhost:5173) to chat with your agents'
    );
};

startAgents().catch(error => {
    elizaLogger.error('Unhandled error in startAgents:', error);
    tokimonsterNotification.error('[Tokimonster] Unhandled error in startAgents');
    process.exit(1); // Exit the process after logging
});
