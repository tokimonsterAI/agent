import {
    Client,
    elizaLogger,
    IAgentRuntime
} from '@elizaos/core';
import {TwitterApi} from 'twitter-api-v2';

import {ClientBase} from './base.ts';
import {validateTwitterConfig, TwitterConfig} from './environment.ts';
import {TwitterInteractionClient} from './interactions.ts';

let twitterApiClient: TwitterApi; // TODO(pancake) this is a temporary solution, try get the client from runtime
export const getTwitterApiClient = (): TwitterApi | undefined => twitterApiClient;

/**
 * A manager that orchestrates all specialized Twitter logic:
 * - client: base operations (login, timeline caching, etc.)
 * - interaction: handling mentions, replies
 */
class TwitterManager {

    apiClient: TwitterApi;
    client: ClientBase;
    interaction: TwitterInteractionClient;

    constructor(runtime: IAgentRuntime, twitterConfig: TwitterConfig) {
        // Init Twitter API V2
        this.apiClient = new TwitterApi({
            appKey: twitterConfig.TWITTER_APP_KEY,
            appSecret: twitterConfig.TWITTER_APP_SECRET,
            accessToken: twitterConfig.TWITTER_ACCESS_TOKEN,
            accessSecret: twitterConfig.TWITTER_ACCESS_SECRET,
        });

        twitterApiClient = this.apiClient;

        // Pass twitterConfig to the base client
        this.client = new ClientBase(runtime, twitterConfig);

        // Mentions and interactions
        this.interaction = new TwitterInteractionClient(this.apiClient, this.client, runtime);
    }

}

export const TwitterClientInterface: Client = {
    async start(runtime: IAgentRuntime) {
        const twitterConfig: TwitterConfig = await validateTwitterConfig(runtime);

        elizaLogger.info('Twitter client started');

        const manager = new TwitterManager(runtime, twitterConfig);

        // Initialize login/session
        await manager.client.init();

        // Start interactions (mentions, replies)
        await manager.interaction.start();

        return manager;
    },

    async stop(_runtime: IAgentRuntime) { // eslint-disable-line @typescript-eslint/no-unused-vars
        elizaLogger.warn('Twitter client does not support stopping yet');
    },
};

export default TwitterClientInterface;
