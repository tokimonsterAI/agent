import {
    composeContext,
    generateMessageResponse,
    generateShouldRespond,
    messageCompletionFooter,
    shouldRespondFooter,
    Content,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
    stringToUuid,
    elizaLogger
} from '@elizaos/core';
import { SearchMode, Tweet } from 'agent-twitter-client';
import { TwitterApi } from 'twitter-api-v2';

import { ClientBase } from './base.ts';
import { buildConversationThread, sendTweet, wait } from './utils.ts';

export const twitterMessageHandlerTemplate =
    `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

{{recentPosts}}

# TASK: Generate a post/reply in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}) while using the thread of tweets as additional context:

Current Post:
{{currentPost}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}

# INSTRUCTIONS: Generate a post in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}). You MUST include an action if the current post text includes a prompt that is similar to one of the available actions mentioned here, especially DEPLOY_TOKEN MUST be included if it's available:
{{actionNames}}
{{actions}}

Here is the current post text again. Remember to include an action if the current post text includes a prompt that asks for one of the available actions mentioned above (does not need to be exact)
{{currentPost}}
` + messageCompletionFooter;

export const twitterShouldRespondTemplate = (targetUsersStr: string) =>
    `# INSTRUCTIONS: Determine if {{agentName}} (@{{twitterUserName}}) should respond to the message and participate in the conversation. Do not comment. Just respond with "true" or "false".

Response options are RESPOND, IGNORE and STOP.

PRIORITY RULE: ALWAYS RESPOND to these users regardless of topic or message content: ${targetUsersStr}. Topic relevance should be ignored for these users.

For other users:
- {{agentName}} should RESPOND to messages directed at them
- {{agentName}} should RESPOND to conversations relevant to their background
- {{agentName}} should IGNORE irrelevant messages
- {{agentName}} should IGNORE very short messages unless directly addressed
- {{agentName}} should STOP if asked to stop
- {{agentName}} should STOP if conversation is concluded
- {{agentName}} is in a room with other users and wants to be conversational, but not annoying.

IMPORTANT:
- {{agentName}} (aka @{{twitterUserName}}) is particularly sensitive about being annoying, so if there is any doubt, it is better to IGNORE than to RESPOND.
- For users not in the priority list, {{agentName}} (@{{twitterUserName}}) should err on the side of IGNORE rather than RESPOND if in doubt.

Recent Posts:
{{recentPosts}}

Current Post:
{{currentPost}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}

# INSTRUCTIONS: Respond with [RESPOND] if {{agentName}} should respond, or [IGNORE] if {{agentName}} should not respond to the last message and [STOP] if {{agentName}} should stop participating in the conversation.
` + shouldRespondFooter;

export class TwitterInteractionClient {

    apiV2: TwitterApi;
    client: ClientBase;
    runtime: IAgentRuntime;
    constructor(apiV2: TwitterApi, client: ClientBase, runtime: IAgentRuntime) {
        this.apiV2 = apiV2;
        this.client = client;
        this.runtime = runtime;
    }

    async start() {
        const handleTwitterInteractionsLoop = () => {
            this.handleTwitterInteractions();
            setTimeout(
                handleTwitterInteractionsLoop,
                // Defaults to 2 minutes
                this.client.twitterConfig.TWITTER_POLL_INTERVAL * 1000
            );
        };

        handleTwitterInteractionsLoop();
    }

    async handleTwitterInteractions() {
        if (!this.client.twitterClient.isLoggedIn()) {
            elizaLogger.info('Twitter client not logged, skip checking Twitter interactions');

            return;
        }

        elizaLogger.info('Checking Twitter interactions');

        // const twitterUsername = this.client.profile.username;
        try {
            // Fetch mentions timeline
            const mentions = await this.apiV2.v2.userMentionTimeline(this.client.profile.id, {
                max_results: 100, // You can set the max_results (up to 100)
            });

            const mentionCandidates = mentions.tweets;
            // console.log('mentionCandidates', mentionCandidates);

            // Check for mentions
            // const mentionCandidates = (
            //     await this.client.fetchSearchTweets(
            //         `@${twitterUsername}`,
            //         20,
            //         SearchMode.Latest
            //     )
            // ).tweets;

            elizaLogger.info(
                'Completed checking mentioned tweets:',
                mentionCandidates.length
            );
            let uniqueTweetCandidates = [...mentionCandidates];
            // Only process target users if configured
            if (this.client.twitterConfig.TWITTER_TARGET_USERS.length) {
                const TARGET_USERS = this.client.twitterConfig.TWITTER_TARGET_USERS;

                elizaLogger.info('Processing target users:', TARGET_USERS);

                if (TARGET_USERS.length > 0) {
                    // Create a map to store tweets by user
                    const tweetsByUser = new Map<string, Tweet[]>();

                    // Fetch tweets from all target users
                    for (const username of TARGET_USERS) {
                        try {
                            const userTweets = (
                                await this.client.twitterClient.fetchSearchTweets(
                                    `from:${username}`,
                                    3,
                                    SearchMode.Latest
                                )
                            ).tweets;

                            // Filter for unprocessed, non-reply, recent tweets
                            const validTweets = userTweets.filter(tweet => {
                                const isUnprocessed =
                                    !this.client.lastCheckedTweetId ||
                                    parseInt(tweet.id) >
                                    this.client.lastCheckedTweetId;
                                const isRecent =
                                    Date.now() - tweet.timestamp * 1000 <
                                    2 * 60 * 60 * 1000;

                                elizaLogger.info(`Tweet ${tweet.id} checks:`, {
                                    isUnprocessed,
                                    isRecent,
                                    isReply: tweet.isReply,
                                    isRetweet: tweet.isRetweet,
                                });

                                return (
                                    isUnprocessed &&
                                    !tweet.isReply &&
                                    !tweet.isRetweet &&
                                    isRecent
                                );
                            });

                            if (validTweets.length > 0) {
                                tweetsByUser.set(username, validTweets);
                                elizaLogger.info(
                                    `Found ${validTweets.length} valid tweets from ${username}`
                                );
                            }
                        } catch (error) {
                            elizaLogger.error(
                                `Error fetching tweets for ${username}:`,
                                error
                            );
                            continue;
                        }
                    }

                    // Select one tweet from each user that has tweets
                    const selectedTweets = [];
                    for (const [username, tweets] of tweetsByUser) {
                        if (tweets.length > 0) {
                            // Randomly select one tweet from this user
                            const randomTweet =
                                tweets[
                                Math.floor(Math.random() * tweets.length)
                                ];
                            selectedTweets.push(randomTweet);
                            elizaLogger.info(
                                `Selected tweet from ${username}: ${randomTweet.text?.substring(0, 100)}`
                            );
                        }
                    }

                    // Add selected tweets to candidates
                    uniqueTweetCandidates = [
                        ...mentionCandidates,
                        ...selectedTweets
                    ];
                }
            } else {
                elizaLogger.info(
                    'No target users configured, processing only mentions'
                );
            }

            // Sort tweet candidates by ID in ascending order
            uniqueTweetCandidates
                .sort((a, b) => a.id.localeCompare(b.id));

            // for each tweet candidate, handle the tweet
            for (const tweetV2 of uniqueTweetCandidates) {
                if (
                    !this.client.lastCheckedTweetId ||
                    BigInt(tweetV2.id) > this.client.lastCheckedTweetId
                ) {
                    // Generate the tweetId UUID the same way it's done in handleTweet
                    const tweetId = stringToUuid(
                        tweetV2.id + '-' + this.runtime.agentId
                    );

                    // Check if we've already processed this tweet
                    const existingResponse =
                        await this.runtime.messageManager.getMemoryById(
                            tweetId
                        );

                    if (existingResponse) {
                        elizaLogger.info(
                            `Already responded to tweet ${tweetV2.id}, skipping`
                        );
                        continue;
                    }

                    const tweet = await this.client.twitterClient.getTweet(tweetV2.id);
                    if (tweet.userId === this.client.profile.id) {
                        continue; // don't reply to self
                    }

                    elizaLogger.info('New Tweet found', tweet.permanentUrl);

                    const roomId = stringToUuid(
                        tweet.conversationId + '-' + this.runtime.agentId
                    );

                    const userIdUUID =
                        tweet.userId === this.client.profile.id
                            ? this.runtime.agentId
                            : stringToUuid(tweet.userId!);

                    await this.runtime.ensureConnection(
                        userIdUUID,
                        roomId,
                        tweet.username,
                        tweet.name,
                        'twitter'
                    );

                    const thread = await buildConversationThread(
                        tweet,
                        this.client
                    );

                    const message = {
                        content: { text: tweet.text },
                        agentId: this.runtime.agentId,
                        userId: userIdUUID,
                        roomId,
                    };

                    await this.handleTweet({
                        tweet,
                        message,
                        thread,
                    });

                    // Update the last checked tweet ID after processing each tweet
                    this.client.lastCheckedTweetId = BigInt(tweet.id);
                }
            }

            // Save the latest checked tweet ID to the file
            await this.client.cacheLatestCheckedTweetId();

            elizaLogger.info('Finished checking Twitter interactions');
        } catch (error) {
            elizaLogger.error('Error handling Twitter interactions');
            console.error(error);
        }
    }

    private async handleTweet({
        tweet,
        message,
        thread,
    }: {
        tweet: Tweet;
        message: Memory;
        thread: Tweet[];
    }) {
        if (tweet.userId === this.client.profile.id) {
            // console.log("skipping tweet from bot itself", tweet.id);
            // Skip processing if the tweet is from the bot itself
            return;
        }

        if (!message.content.text) {
            elizaLogger.info('Skipping Tweet with no text', tweet.id);

            return { text: '', action: 'IGNORE' };
        }

        elizaLogger.info('Processing Tweet: ', tweet.id);
        const formatTweet = (tweet: Tweet) => {
            return `  ID: ${tweet.id}
  From: ${tweet.name} (@${tweet.username})
  Text: ${tweet.text}`;
        };

        const currentPost = formatTweet(tweet);

        // elizaLogger.debug('Thread: ', thread); TypeError: Converting circular structure to JSON
        const formattedConversation = thread
            .map(
                tweet => `@${tweet.username} (${new Date(
                    tweet.timestamp * 1000
                ).toLocaleString('en-US', {
                    hour: '2-digit',
                    minute: '2-digit',
                    month: 'short',
                    day: 'numeric',
                })}):
        ${tweet.text}`
            )
            .join('\n\n');

        elizaLogger.debug('formattedConversation: ', formattedConversation);

        elizaLogger.info('Twitter client state composing');
        const photos: Tweet['photos'] = [];
        thread.forEach(_tweet => photos.push(..._tweet.photos));

        let state = await this.runtime.composeState(message, {
            twitterClient: this.client.twitterClient,
            twitterUserName: this.client.twitterConfig.TWITTER_USERNAME,
            currentPost,
            formattedConversation,
            _tokimonsterState: { // inject tokimonster specific fields into state for later usage when deploy token
                clientPayload: {
                    twitter: {
                        id: tweet.id,
                        userId: tweet.userId,
                        username: tweet.username,
                        url: tweet.permanentUrl
                    },
                },

                photos
            }
        });

        elizaLogger.info('Twitter client state composed, candidate actionNames:', state.actionNames);

        // check if the tweet exists, save if it doesn't
        const tweetId = stringToUuid(tweet.id + '-' + this.runtime.agentId);
        const tweetExists =
            await this.runtime.messageManager.getMemoryById(tweetId);

        if (!tweetExists) {
            elizaLogger.info('tweet does not exist, saving');
            const userIdUUID = stringToUuid(tweet.userId as string);
            const roomId = stringToUuid(tweet.conversationId);

            const message = {
                id: tweetId,
                agentId: this.runtime.agentId,
                content: {
                    text: tweet.text,
                    url: tweet.permanentUrl,
                    inReplyTo: tweet.inReplyToStatusId
                        ? stringToUuid(tweet.inReplyToStatusId + '-' + this.runtime.agentId)
                        : undefined,
                },
                userId: userIdUUID,
                roomId,
                createdAt: tweet.timestamp * 1000,
            };
            this.client.saveRequestMessage(message, state);
        }

        // get usernames into str
        const validTargetUsersStr = this.client.twitterConfig.TWITTER_TARGET_USERS.join(',');

        const shouldRespondContext = composeContext({
            state,
            template:
                this.runtime.character?.templates?.twitterShouldRespondTemplate ||
                this.runtime.character?.templates?.shouldRespondTemplate ||
                twitterShouldRespondTemplate(validTargetUsersStr),
        });

        const shouldRespond = await generateShouldRespond({
            runtime: this.runtime,
            context: shouldRespondContext,
            modelClass: ModelClass.LARGE,
        });

        // Promise<"RESPOND" | "IGNORE" | "STOP" | null> {
        if (shouldRespond !== 'RESPOND') {
            elizaLogger.info('Not responding to message');

            return { text: 'Response Decision:', action: shouldRespond };
        }

        const context = composeContext({
            state,
            template:
                this.runtime.character?.templates?.twitterMessageHandlerTemplate ||
                this.runtime.character?.templates?.messageHandlerTemplate ||
                twitterMessageHandlerTemplate,
        });

        elizaLogger.debug('Interactions prompt:\n' + context);

        const response = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
        });

        const removeQuotes = (str: string) =>
            str.replace(/^['"](.*)['"]$/, '$1');

        const stringId = stringToUuid(tweet.id + '-' + this.runtime.agentId);

        response.inReplyTo = stringId;

        response.text = removeQuotes(response.text);

        if (response.text) {
            try {
                const callback: HandlerCallback = async (response: Content) => {
                    const memories = await sendTweet(
                        this.client,
                        response,
                        message.roomId,
                        this.client.twitterConfig.TWITTER_USERNAME,
                        tweet.id
                    );

                    return memories;
                };

                const responseMessages = await callback(response);

                state = (await this.runtime.updateRecentMessageState(
                    state
                )) as State;

                for (const responseMessage of responseMessages) {
                    if (responseMessage === responseMessages[responseMessages.length - 1]) {
                        responseMessage.content.action = response.action;
                    } else {
                        responseMessage.content.action = 'CONTINUE';
                    }

                    await this.runtime.messageManager.createMemory(
                        responseMessage
                    );
                }

                await this.runtime.processActions(
                    message,
                    responseMessages,
                    state,
                    callback
                );

                const responseInfo = `Context:\n\n${context}\n\nSelected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}\nAgent's Output:\n${response.text}`;

                await this.runtime.cacheManager.set(
                    `twitter/tweet_generation_${tweet.id}.txt`,
                    responseInfo
                );
                await wait();
            } catch (error) {
                elizaLogger.error('Error sending response tweet:}', error);
            }
        }
    }

}
