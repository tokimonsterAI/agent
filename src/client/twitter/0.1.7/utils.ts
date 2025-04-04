import fs from 'fs';
import path from 'path';

import {getEmbeddingZeroVector, Content, Memory, UUID, stringToUuid, elizaLogger, Media} from '@elizaos/core';
import {Tweet} from 'agent-twitter-client';

import {ClientBase} from './base';

export const wait = (minTime = 1000, maxTime = 3000) => {
    const waitTime =
        Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;

    return new Promise(resolve => setTimeout(resolve, waitTime));
};

export const isValidTweet = (tweet: Tweet): boolean => {
    // Filter out tweets with too many hashtags, @s, or $ signs, probably spam or garbage
    const hashtagCount = (tweet.text?.match(/#/g) || []).length;
    const atCount = (tweet.text?.match(/@/g) || []).length;
    const dollarSignCount = (tweet.text?.match(/\$/g) || []).length;
    const totalCount = hashtagCount + atCount + dollarSignCount;

    return (
        hashtagCount <= 1 &&
        atCount <= 2 &&
        dollarSignCount <= 1 &&
        totalCount <= 3
    );
};

export async function buildConversationThread(
    tweet: Tweet,
    client: ClientBase,
    maxReplies = 10
): Promise<Tweet[]> {
    const thread: Tweet[] = [];
    const visited: Set<string> = new Set();

    async function processThread(currentTweet: Tweet, depth = 0) {
        elizaLogger.debug('Processing tweet:', {
            id: currentTweet.id,
            inReplyToStatusId: currentTweet.inReplyToStatusId,
            depth: depth,
        });

        if (!currentTweet) {
            elizaLogger.debug('No current tweet found for thread building');

            return;
        }

        // Stop if we've reached our reply limit
        if (depth >= maxReplies) {
            elizaLogger.debug('Reached maximum reply depth', depth);

            return;
        }

        // Handle memory storage
        const memory = await client.runtime.messageManager.getMemoryById(
            stringToUuid(currentTweet.id + '-' + client.runtime.agentId)
        );
        if (!memory) {
            const roomId = stringToUuid(
                currentTweet.conversationId + '-' + client.runtime.agentId
            );
            const userId = stringToUuid(currentTweet.userId);

            await client.runtime.ensureConnection(
                userId,
                roomId,
                currentTweet.username,
                currentTweet.name,
                'twitter'
            );

            // save currentTweet
            await client.runtime.messageManager.createMemory({
                id: stringToUuid(
                    currentTweet.id + '-' + client.runtime.agentId
                ),
                agentId: client.runtime.agentId,
                content: {
                    text: currentTweet.text,
                    source: 'twitter',
                    url: currentTweet.permanentUrl,
                    inReplyTo: currentTweet.inReplyToStatusId
                        ? stringToUuid(
                            currentTweet.inReplyToStatusId +
                            '-' +
                            client.runtime.agentId
                        )
                        : undefined,
                },
                createdAt: currentTweet.timestamp * 1000,
                roomId,
                userId:
                    currentTweet.userId === client.profile.id
                        ? client.runtime.agentId
                        : stringToUuid(currentTweet.userId),
                embedding: getEmbeddingZeroVector(),
            });
        }

        if (visited.has(currentTweet.id)) {
            elizaLogger.debug('Already visited tweet:', currentTweet.id);

            return;
        }

        visited.add(currentTweet.id);
        thread.unshift(currentTweet);

        elizaLogger.debug('Current thread state:', {
            length: thread.length,
            currentDepth: depth,
            tweetId: currentTweet.id,
        });

        // If there's a parent tweet, fetch and process it
        if (currentTweet.inReplyToStatusId) {
            elizaLogger.debug(
                'Fetching parent tweet:',
                currentTweet.inReplyToStatusId
            );
            try {
                const parentTweet = await client.twitterClient.getTweet(
                    currentTweet.inReplyToStatusId
                );
                elizaLogger.debug(
                    'Fetched parent tweet:',
                    currentTweet.inReplyToStatusId
                );

                if (parentTweet) {
                    elizaLogger.debug('Found parent tweet:', {
                        id: parentTweet.id,
                        text: parentTweet.text?.slice(0, 50),
                    });
                    await processThread(parentTweet, depth + 1);
                } else {
                    elizaLogger.debug(
                        'No parent tweet found for:',
                        currentTweet.inReplyToStatusId
                    );
                }
            } catch (error) {
                elizaLogger.error(`Error fetching parent tweet: ${currentTweet.inReplyToStatusId}`, error);
            }
        } else {
            elizaLogger.debug(
                'Reached end of reply chain at:',
                currentTweet.id
            );
        }
    }

    await processThread(tweet, 0);

    elizaLogger.debug('Final thread built:', {
        totalTweets: thread.length,
        tweetIds: thread.map(t => ({
            id: t.id,
            text: t.text?.slice(0, 50),
            photoCount: t.photos.length
        })),
    });

    return thread;
}

export async function sendTweet(
    client: ClientBase,
    content: Content,
    roomId: UUID,
    twitterUsername: string,
    inReplyTo: string
): Promise<Memory[]> {
    const maxTweetLength = client.twitterConfig.MAX_TWEET_LENGTH;
    const isLongTweet = maxTweetLength > 280;

    const tweetChunks = splitTweetContent(content.text, maxTweetLength);
    const sentTweets: Tweet[] = [];
    let previousTweetId = inReplyTo;

    for (const chunk of tweetChunks) {
        let mediaData: { data: Buffer; mediaType: string }[] | undefined;

        if (content.attachments && content.attachments.length > 0) {
            mediaData = await Promise.all(
                content.attachments.map(async (attachment: Media) => {
                    if (/^(http|https):\/\//.test(attachment.url)) {
                        // Handle HTTP URLs
                        const response = await fetch(attachment.url);
                        if (!response.ok) {
                            throw new Error(
                                `Failed to fetch file: ${attachment.url}`
                            );
                        }

                        const mediaBuffer = Buffer.from(
                            await response.arrayBuffer()
                        );
                        const mediaType = attachment.contentType;

                        return {data: mediaBuffer, mediaType};
                    } else if (fs.existsSync(attachment.url)) {
                        // Handle local file paths
                        const mediaBuffer = await fs.promises.readFile(
                            path.resolve(attachment.url)
                        );
                        const mediaType = attachment.contentType;

                        return {data: mediaBuffer, mediaType};
                    } else {
                        throw new Error(
                            `File not found: ${attachment.url}. Make sure the path is correct.`
                        );
                    }
                })
            );
        }

        const result = await client.requestQueue.add(async () =>
            isLongTweet
                ? client.twitterClient.sendLongTweet(chunk.trim(), previousTweetId, mediaData)
                : client.twitterClient.sendTweet(chunk.trim(), previousTweetId, mediaData)
        );

        const body = await result.json();
        const tweetResult = isLongTweet
            ? body.data.notetweet_create.tweet_results.result
            : body.data.create_tweet.tweet_results.result;

        // if we have a response
        if (tweetResult) {
            // Parse the response
            const finalTweet: Tweet = {
                id: tweetResult.rest_id,
                text: tweetResult.legacy.full_text,
                conversationId: tweetResult.legacy.conversation_id_str,
                timestamp:
                    new Date(tweetResult.legacy.created_at).getTime() / 1000,
                userId: tweetResult.legacy.user_id_str,
                inReplyToStatusId: tweetResult.legacy.in_reply_to_status_id_str,
                permanentUrl: `https://twitter.com/${twitterUsername}/status/${tweetResult.rest_id}`,
                hashtags: [],
                mentions: [],
                photos: [],
                thread: [],
                urls: [],
                videos: [],
            };
            sentTweets.push(finalTweet);
            previousTweetId = finalTweet.id;
        } else {
            elizaLogger.error('Error sending tweet chunk:', {chunk, response: body});
        }

        // Wait a bit between tweets to avoid rate limiting issues
        await wait(1000, 2000);
    }

    const memories: Memory[] = sentTweets.map(tweet => ({
        id: stringToUuid(tweet.id + '-' + client.runtime.agentId),
        agentId: client.runtime.agentId,
        userId: client.runtime.agentId,
        content: {
            text: tweet.text,
            source: 'twitter',
            url: tweet.permanentUrl,
            inReplyTo: tweet.inReplyToStatusId
                ? stringToUuid(
                    tweet.inReplyToStatusId + '-' + client.runtime.agentId
                )
                : undefined,
        },
        roomId,
        embedding: getEmbeddingZeroVector(),
        createdAt: tweet.timestamp * 1000,
    }));

    return memories;
}

function splitTweetContent(content: string, maxLength: number): string[] {
    const paragraphs = content.split('\n\n').map(p => p.trim());
    const tweets: string[] = [];
    let currentTweet = '';

    for (const paragraph of paragraphs) {
        if (!paragraph) continue;

        if ((currentTweet + '\n\n' + paragraph).trim().length <= maxLength) {
            if (currentTweet) {
                currentTweet += '\n\n' + paragraph;
            } else {
                currentTweet = paragraph;
            }
        } else {
            if (currentTweet) {
                tweets.push(currentTweet.trim());
            }

            if (paragraph.length <= maxLength) {
                currentTweet = paragraph;
            } else {
                // Split long paragraph into smaller chunks
                const chunks = splitParagraph(paragraph, maxLength);
                tweets.push(...chunks.slice(0, -1));
                currentTweet = chunks[chunks.length - 1];
            }
        }
    }

    if (currentTweet) {
        tweets.push(currentTweet.trim());
    }

    return tweets;
}

function splitParagraph(paragraph: string, maxLength: number): string[] {
    // eslint-disable-next-line
    const sentences = paragraph.match(/[^\.!\?]+[\.!\?]+|[^\.!\?]+$/g) || [
        paragraph
    ];
    const chunks: string[] = [];
    let currentChunk = '';

    for (const sentence of sentences) {
        if ((currentChunk + ' ' + sentence).trim().length <= maxLength) {
            if (currentChunk) {
                currentChunk += ' ' + sentence;
            } else {
                currentChunk = sentence;
            }
        } else {
            if (currentChunk) {
                chunks.push(currentChunk.trim());
            }

            if (sentence.length <= maxLength) {
                currentChunk = sentence;
            } else {
                // Split long sentence into smaller pieces
                const words = sentence.split(' ');
                currentChunk = '';
                for (const word of words) {
                    if (
                        (currentChunk + ' ' + word).trim().length <= maxLength
                    ) {
                        if (currentChunk) {
                            currentChunk += ' ' + word;
                        } else {
                            currentChunk = word;
                        }
                    } else {
                        if (currentChunk) {
                            chunks.push(currentChunk.trim());
                        }

                        currentChunk = word;
                    }
                }
            }
        }
    }

    if (currentChunk) {
        chunks.push(currentChunk.trim());
    }

    return chunks;
}
