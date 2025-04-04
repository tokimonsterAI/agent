/* eslint-disable no-underscore-dangle */

import {
    Aptos,
    AptosConfig,
    Network,
    PrivateKey,
    Ed25519PrivateKey,
    PrivateKeyVariants,
} from "@aptos-labs/ts-sdk";
import {
    Action,
    Content,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
    composeContext,
    elizaLogger,
    generateObject,
    parseBooleanFromText
} from '@elizaos/core';
import { z } from 'zod';

import { validateTwitterConfig } from '../../client/twitter/0.1.7/environment.ts';
import { getTwitterApiClient } from '../../client/twitter/0.1.7/index.ts';
import tokimonsterNotification from '../../util/notification.ts';
import { getTokimonsterState, isValidClientPayload } from '../utils.ts';

const MIN_POINTS = 200;

const evalutationTemplate = `
Respond with a pure JSON string containing only the extracted values, please don't add anything pre or post the JSON body. Omit fields whose values cannot be determined.

Example response:
{
    "tokenMetadata": {
        "name": "Test Token",
        "symbol": "TEST",
    },
    "scores": {
        "virality": 95,
        "storytelling": 70,
        "innovation": 85,
        "mood": 60
    },
    "totalScores": 310,
    "approved": true
}



{{recentMessages}}

Given the recent messages, please give scores in the following four dimensions:
- virality: i.e. Virality Potential, How likely is the token to gain traction and spread widely. High-scoring examples for Virality Potential:
  - Celebrity-related: Tokens that are associated with famous figures or influencers.
  - Trending Event-related: Tokens linked to current, widely-discussed events or movements.
  - Particularly Interesting Incidents: Tokens connected to highly engaging, unusual, or fascinating events that capture public attention.
  - These factors would be given higher scores based on how likely they are to go viral due to their relevance and appeal.
- storytelling: i.e. Storytelling Strength, Does the token have a compelling narrative that makes it memorable. High-scoring examples for Storytelling Strength:
  - Tokens based on touching stories, hero stories, celebrity stories, or very interesting stories can earn high scores for Storytelling Strength.
  - These types of narratives resonate emotionally with people, making the token more memorable and engaging.
- innovation: i.e. Innovation & Uniqueness, Does the token bring something new or creative to the space. Do not require the project to have innovation or uniqueness in blockchain technology or crypto technology.
- mood: i.e. Tokimonster's Personal Mood, Is Tokimonster in the right mood to assist. (Unpredictable but crucial factor.)

Tokimonster primarily considers the token's potential for virality; utility and innovative features are not important.    
The total score is 400 points, with Virality Potential and Storytelling Strength each worth 150 points, and Innovation & Uniqueness and Tokimonster's Personal Mood each worth 50 points.

Additionally, please extract the following information about the requested token creation:
- Token name
- Token symbol

If the total score reaches ${MIN_POINTS} points and Token name & symbol are provided, the token will be approved for launch, and Tokimonster will execute the DEPLOY_TOKEN action to deploy it.
`;

const EvalutationContentSchema = z.object({
    tokenMetadata: z.object({
        name: z.string().optional(),
        symbol: z.string().optional()
    }),
    scores: z.object({
        virality: z.number().optional(),
        storytelling: z.number().optional(),
        innovation: z.number().optional(),
        mood: z.number().optional()
    }),
    totalScores: z.number().optional(),
    approved: z.boolean().optional()
});

export interface EvaluationContent extends Content {
    tokenMetadata?: {
        name?: string;
        symbol?: string;
    };
    scores?: {
        virality?: number;
        storytelling?: number;
        innovation?: number;
        mood?: number;
    };
    totalScores?: number;
    approved?: boolean;
}

const DEFAULT_SUPPLY = '10000000000'; // 100B

const extractTokenInfoTemplate = `Respond with a JSON string containing only the extracted values. Omit fields whose values cannot be determined.

Example response:
{
    "tokenMetadata": {
        "name": "Test Token",
        "symbol": "TEST",
        "supply": "${DEFAULT_SUPPLY}"
    }
}


{{recentMessages}}

Given the recent messages, extract the following information about the requested token creation:
- Token name (required)
- Token symbol (required)
- Total supply (optional, default ${DEFAULT_SUPPLY})
`;

const DeployTokenContentSchema = z.object({
    tokenMetadata: z.object({
        name: z.string().optional(),
        symbol: z.string().optional(),
        supply: z.string().optional()
    })
});

export interface TokenInfoContent extends Content {
    tokenMetadata: {
        name: string;
        symbol: string;
        supply: string;
    };
}

const contractAddress = '0x360d4b3ce4a3f48470ded6b55a820abfe1d1cde1daa1ca966f31bbece23c171b';
const contractName = 'Tokimonster';
const feeTier = 3;
const tick = 200; // this must be corresponding to feeTier
const pairedTokenAddress = '0x000000000000000000000000000000000000000000000000000000000000000a';

const defaultFID = 741187;
const defaultCastHash = '{}';
const defaultImage = 'https://testnet.tokimonster.io/static/default-token-image.jpeg';

let timestampDeployCount = 0;
const maxCount = 20;

const deployToken: Action = {
    name: 'DEPLOY_TOKEN',
    similes: ['CREATE_TOKEN', 'LAUNCH_TOKEN', 'ISSUE_TOKEN'],
    description: 'Deploy a new token based on the user\'s eligibility',

    examples: [
        [
            {
                user: '{{user1}}',
                content: {
                    text: 'Deploy a new token called Lilys with symbol LYS, and total supply is 1M',
                },
            },
            {
                user: '{{user2}}',
                content: {
                    text: 'I will deploy token Lilys (LYS) with 1M total supply for you.',
                    action: 'DEPLOY_TOKEN',
                    content: {
                        tokenMetadata: {
                            name: 'Lilys',
                            symbol: 'LYS',
                            supply: '1000000'
                        },
                    },
                },
            }
        ],
        [
            {
                user: '{{user1}}',
                content: {
                    text: 'Deploy a new token called Lilys with symbol LYS',
                },
            },
            {
                user: '{{user2}}',
                content: {
                    text: 'I will deploy token Lilys (LYS) with 100B total supply for you.',
                    action: 'DEPLOY_TOKEN',
                    content: {
                        tokenMetadata: {
                            name: 'Lilys',
                            symbol: 'LYS',
                            supply: DEFAULT_SUPPLY
                        },
                    },
                },
            }
        ],
        [
            {
                user: '{{user1}}',
                content: {
                    text: 'Deploy a new token for me',
                },
            },
            {
                user: '{{user2}}',
                content: {
                    text: 'Sure, could you tell me what name and symbol would you like to use?',
                    action: 'NONE'
                },
            }
        ]
    ],

    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        elizaLogger.info(`[TokimonsterPlugin][deployToken][validate] userId: ${message.userId}, content:`, message.content);

        if (timestampDeployCount - getDayStartTimestap() > maxCount) {
            elizaLogger.warn('[TokimonsterPlugin][deployToken][validate] hard limit reached', {
                timestampDeployCount,
                dayStartTimestamp: getDayStartTimestap()
            });

            return false;
        }

        // composeState if not exsits
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        elizaLogger.info('[TokimonsterPlugin][deployToken][validate] state composed');

        const tokimonsterState = getTokimonsterState(state);
        console.log('[TokimonsterPlugin][deployToken][validate] tokimonsterState', tokimonsterState);
        const { clientPayload } = tokimonsterState;
        const notification = {
            userId: message.userId,
            ...(clientPayload?.twitter ? { twitter: clientPayload.twitter } : {}),
            source: message.content.source,
            text: message.content.text?.slice(0, 100),
        };

        // Generate structured content from natural language for evalutation result
        const evalutationContext = composeContext({
            state,
            template: evalutationTemplate,
        });

        elizaLogger.info('[TokimonsterPlugin][deployToken][validate] evalutationContext composed');

        let evaluationContent;
        try {
            evaluationContent = (await generateObject({
                runtime,
                context: evalutationContext,
                modelClass: ModelClass.LARGE,
                schema: EvalutationContentSchema
            })).object as unknown as EvaluationContent;
        } catch (err) {
            console.error(`[TokimonsterPlugin][deployToken][validate] failed to generateObject for EvalutationContext, userId: ${message.userId}`, err);
            tokimonsterNotification.error(`[TokimonsterPlugin][deployToken][validate] failed to generateObject for EvalutationContext, userId: ${message.userId}`);

            return false;
        }

        console.log('[TokimonsterPlugin][deployToken][validate] evaluationContent parsed', evaluationContent);

        if (!evaluationContent.approved) {
            elizaLogger.info('[TokimonsterPlugin][deployToken][validate] evaluation failed');
            tokimonsterNotification.info(JSON.stringify({
                ...notification,
                ...evaluationContent
            }, null, 2));

            return false;
        }

        elizaLogger.info('[TokimonsterPlugin][deployToken][validate] evaluation passed, checking client eligibility');

        // Twitter eligibility check
        if (clientPayload?.twitter?.username && !await isTwitterEligibleToDeployToken(runtime, clientPayload.twitter.username)) {
            elizaLogger.info('[TokimonsterPlugin][deployToken][validate] user is not eligiable to deploy token', clientPayload.twitter.username);
            tokimonsterNotification.info(JSON.stringify({
                ...notification,
                ...evaluationContent,
                isTwitterAccountEligible: false,
            }, null, 2));

            return false;
        }

        tokimonsterNotification.info(JSON.stringify({
            ...notification,
            ...evaluationContent
        }, null, 2));

        return true;
    },

    handler: async (runtime: IAgentRuntime, message: Memory, state: State, options: { [key: string]: unknown; }, callback?: HandlerCallback) => {
        elizaLogger.info(`[TokimonsterPlugin][deployToken] action started, userId: ${message.userId}, content:`, message.content);
        tokimonsterNotification.info(`[TokimonsterPlugin][deployToken] action started, userId: ${message.userId}`);

        // composeState if not exsits
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        elizaLogger.info('[TokimonsterPlugin][deployToken] state composed');

        // Generate structured content from natural language for deploy token
        const deployTokenContext = composeContext({
            state,
            template: extractTokenInfoTemplate,
        });

        elizaLogger.info('[TokimonsterPlugin][deployToken] deployTokenContext composed');

        let deployTokenContent;
        try {
            deployTokenContent = (await generateObject({
                runtime,
                context: deployTokenContext,
                modelClass: ModelClass.LARGE,
                schema: DeployTokenContentSchema
            })).object as unknown as TokenInfoContent;
        } catch (err) {
            console.error(err);
            tokimonsterNotification.error(`[TokimonsterPlugin][deployToken] failed to generateObject for DeployTokenContext, userId: ${message.userId}`);

            return false;
        }

        console.log('[TokimonsterPlugin][deployToken] deployTokenContent parsed', deployTokenContent);

        const {
            name,
            symbol,
            supply
        } = deployTokenContent.tokenMetadata || {};
        if (!name) {
            callback?.({
                text: 'What will be the name of the token?'
            });

            tokimonsterNotification.info(`[TokimonsterPlugin][deployToken] token name is missing, userId: ${message.userId}`);

            return false;
        }

        if (!symbol) {
            callback?.({
                text: 'What will be the symbol of the token?'
            });

            tokimonsterNotification.info(`[TokimonsterPlugin][deployToken] token symbol is missing, userId: ${message.userId}`);

            return false;
        }

        const maxSupply = supply || DEFAULT_SUPPLY;

        // Get tokimonster injected state for last step validation & params
        const tokimonsterState = getTokimonsterState(state);
        console.log('[TokimonsterPlugin][deployToken] handle tokimonsterState', tokimonsterState);
        const { clientPayload, photos } = tokimonsterState;
        if (!isValidClientPayload(clientPayload)) {
            tokimonsterNotification.error(`[TokimonsterPlugin][deployToken] invalid client payload, userId: ${message.userId}`);
            callback({
                text: 'Congratulations! You can @TokimonsterAI on X to deploy the token for you. Thanks!'
            });

            return false;
        }

        elizaLogger.info('[TokimonsterPlugin][deployToken] init wallet and contract');
        const privateKeyStr = runtime.getSetting('WALLET_PRIVATE_KEY');
        if (!privateKeyStr) {
            throw new Error('WALLET_PRIVATE_KEY is not provided');
        }

        const config = new AptosConfig({ network: Network.TESTNET });
        const aptos = new Aptos(config);
        const privateKey = new Ed25519PrivateKey(PrivateKey.formatPrivateKey(privateKeyStr, PrivateKeyVariants.Ed25519));
        const deployer = await aptos.account.deriveAccountFromPrivateKey({ privateKey });

        const salt = `0x${Math.round(Math.random() * 1_000_000_000).toString(16)}`;
        const fid = clientPayload?.twitter?.userId || defaultFID;
        const castHash = clientPayload?.twitter?.userId ? JSON.stringify(clientPayload) : defaultCastHash;
        const image = photos?.[0]?.url || defaultImage;

        const functionArguments = [
            name,
            symbol,
            maxSupply,
            feeTier,
            salt,
            deployer.accountAddress,
            fid,
            image,
            castHash,
            tick,
            pairedTokenAddress
        ];

        console.log('[TokimonsterPlugin][deployToken] deploy params', functionArguments);

        if (parseBooleanFromText(runtime.getSetting('TOKIMONSTER_DEPLOY_TOKEN_DRY_RUN'))) {
            console.log('[TokimonsterPlugin][deployToken] current in DryRun mode, won\'t execute the contract');
            tokimonsterNotification.info(`[TokimonsterPlugin][deployToken] dry run successfully, userId: ${message.userId}`);
            callback?.({
                text: '[DryRun] Token deployed successfully!'
            });

            return true;
        }

        try {
            timestampDeployCount = Math.max(timestampDeployCount, getDayStartTimestap()) + 1;

            const transaction = await aptos.transaction.build.simple({
                sender: deployer.accountAddress,
                data: {
                    function: `${contractAddress}::${contractName}::deploy_token`,
                    functionArguments
                }
            });

            const transactionSimulateResponse = await aptos.transaction.simulate.simple({
                transaction
            });

            console.log('[TokimonsterPlugin][deployToken] simulated', transactionSimulateResponse);

            if (!transactionSimulateResponse[0].success) {
                callback?.({
                    text: `Failed to deploy token.`
                });

                return false;
            }

            const transactionResponse = await aptos.transaction.signAndSubmitTransaction({
                signer: deployer,
                transaction
            });

            console.log('[TokimonsterPlugin][deployToken] submitted', transactionResponse);

            const committedTransactionResponse = await aptos.transaction.waitForTransaction({
                transactionHash: transactionResponse.hash
            });

            console.log('[TokimonsterPlugin][deployToken] committed', committedTransactionResponse);

            callback?.({
                text: `Token deployed successfully! https://explorer.aptoslabs.com/txn/${committedTransactionResponse.hash}?network=testnet`
            });

            tokimonsterNotification.success(`[TokimonsterPlugin][deployToken] Token deployed successfully! https://explorer.aptoslabs.com/txn/${committedTransactionResponse.hash}?network=testnet, userId: ${message.userId}`);

            return true;
        } catch (err) {
            elizaLogger.error('[TokimonsterPlugin][deployToken] deploy failed');
            console.error(err);
            tokimonsterNotification.error(`[TokimonsterPlugin][deployToken] Token deployed failed, userId: ${message.userId}`);
            // TODO(pancake) reply politely

            return false;
        }
    }
};

const THREE_MONTH_MS = 86400e3 * 30 * 3;

async function isTwitterEligibleToDeployToken(
    runtime: IAgentRuntime,
    username: string
): Promise<boolean> {
    const twitterConfig = await validateTwitterConfig(runtime);

    if (twitterConfig.TOKIMONSTER_TWITTER_WHITELISTED_USERS.includes(username)) {
        return true;
    }

    const apiClient = getTwitterApiClient();
    const response = await apiClient.v2.userByUsername(username, { 'user.fields': 'created_at,id,public_metrics,username' });
    console.log('[TokimonsterPlugin][deployToken][validate] twitter user response', response);

    const userInfo = response.data;
    if (!userInfo || !userInfo.id) {
        // user not found
        elizaLogger.info('[TokimonsterPlugin][deployToken][validate] twitter user not found', username);

        return false;
    }

    if (userInfo.protected || userInfo.withheld) {
        elizaLogger.info('[TokimonsterPlugin][deployToken][validate] twitter user is restricted', username);

        return false;
    }

    const createdDate = new Date(userInfo.created_at);
    if (Date.now() - createdDate.getTime() < THREE_MONTH_MS) {
        elizaLogger.info('[TokimonsterPlugin][deployToken][validate] twitter user was created less than 3 months', username);

        return false;
    }

    if (userInfo.public_metrics.tweet_count < 10) {
        elizaLogger.info('[TokimonsterPlugin][deployToken][validate] twitter user has less than 10 posts', username);

        return false;
    }

    if (userInfo.public_metrics.followers_count < 100) {
        elizaLogger.info('[TokimonsterPlugin][deployToken][validate] twitter user has less than 100 followers', username);

        return false;
    }

    return true;
}

function getDayStartTimestap() {
    return new Date(new Date().toISOString().slice(0, 10)).getTime();
}

export default deployToken;
