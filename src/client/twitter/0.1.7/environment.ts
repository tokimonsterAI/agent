import { parseBooleanFromText, IAgentRuntime } from '@elizaos/core';
import { z, ZodError } from 'zod';

export const DEFAULT_MAX_TWEET_LENGTH = 280;

const twitterUsernameSchema = z
    .string()
    .min(1, 'An X/Twitter Username must be at least 1 characters long')
    .max(15, 'An X/Twitter Username cannot exceed 15 characters')
    .regex(
        /^[A-Za-z0-9_]*$/,
        'An X Username can only contain letters, numbers, and underscores'
    );

/**
 * This schema defines all required/optional environment settings,
 * including new fields like TWITTER_SPACES_ENABLE.
 */
export const twitterEnvSchema = z.object({
    TWITTER_DRY_RUN: z.boolean(),
    TWITTER_USERNAME: z.string().min(1, 'X/Twitter username is required'),
    TWITTER_PASSWORD: z.string().min(1, 'X/Twitter password is required'),
    TWITTER_EMAIL: z.string().email('Valid X/Twitter email is required'),
    MAX_TWEET_LENGTH: z.number().int().default(DEFAULT_MAX_TWEET_LENGTH),
    TWITTER_2FA_SECRET: z.string(),
    TWITTER_APP_KEY: z.string().min(1, 'X/Twitter appKey is required'),
    TWITTER_APP_SECRET: z.string().min(1, 'X/Twitter appSecret is required'),
    TWITTER_ACCESS_TOKEN: z.string().min(1, 'X/Twitter accessToken is required'),
    TWITTER_ACCESS_SECRET: z.string().min(1, 'X/Twitter accessSecret is required'),
    TWITTER_RETRY_LIMIT: z.number().int(),
    TWITTER_POLL_INTERVAL: z.number().int(),
    TWITTER_TARGET_USERS: z.array(twitterUsernameSchema).default([]),
    TOKIMONSTER_TWITTER_WHITELISTED_USERS: z.array(twitterUsernameSchema).default([]),
});

export type TwitterConfig = z.infer<typeof twitterEnvSchema>;

/**
 * Helper to parse a comma-separated list of Twitter usernames
 * (already present in your code).
 */
function parseTargetUsers(targetUsersStr?: string | null): string[] {
    if (!targetUsersStr?.trim()) {
        return [];
    }

    return targetUsersStr
        .split(',')
        .map(user => user.trim())
        .filter(Boolean);
}

function safeParseInt(
    value: string | undefined | null,
    defaultValue: number
): number {
    if (!value) return defaultValue;
    const parsed = parseInt(value, 10);

    return isNaN(parsed) ? defaultValue : Math.max(1, parsed);
}

/**
 * Validates or constructs a TwitterConfig object using zod,
 * taking values from the IAgentRuntime or process.env as needed.
 */
// This also is organized to serve as a point of documentation for the client
// most of the inputs from the framework (env/character)

// we also do a lot of typing/parsing here
// so we can do it once and only once per character
export async function validateTwitterConfig(
    runtime: IAgentRuntime
): Promise<TwitterConfig> {
    try {
        const twitterConfig = {
            TWITTER_DRY_RUN:
                parseBooleanFromText(
                    runtime.getSetting('TWITTER_DRY_RUN') ||
                    process.env.TWITTER_DRY_RUN
                ) ?? false, // parseBooleanFromText return null if "", map "" to false

            TWITTER_USERNAME:
                runtime.getSetting('TWITTER_USERNAME') ||
                process.env.TWITTER_USERNAME,

            TWITTER_PASSWORD:
                runtime.getSetting('TWITTER_PASSWORD') ||
                process.env.TWITTER_PASSWORD,

            TWITTER_EMAIL:
                runtime.getSetting('TWITTER_EMAIL') ||
                process.env.TWITTER_EMAIL,

            // number as string?
            MAX_TWEET_LENGTH: safeParseInt(
                runtime.getSetting('MAX_TWEET_LENGTH') ||
                process.env.MAX_TWEET_LENGTH,
                DEFAULT_MAX_TWEET_LENGTH
            ),

            // string passthru
            TWITTER_2FA_SECRET:
                runtime.getSetting('TWITTER_2FA_SECRET') ||
                process.env.TWITTER_2FA_SECRET ||
                '',

            TWITTER_APP_KEY:
                runtime.getSetting('TWITTER_APP_KEY') ||
                process.env.TWITTER_APP_KEY ||
                '',

            TWITTER_APP_SECRET:
                runtime.getSetting('TWITTER_APP_SECRET') ||
                process.env.TWITTER_APP_SECRET ||
                '',

            TWITTER_ACCESS_TOKEN:
                runtime.getSetting('TWITTER_ACCESS_TOKEN') ||
                process.env.TWITTER_ACCESS_TOKEN ||
                '',

            TWITTER_ACCESS_SECRET:
                runtime.getSetting('TWITTER_ACCESS_SECRET') ||
                process.env.TWITTER_ACCESS_SECRET ||
                '',

            // int
            TWITTER_RETRY_LIMIT: safeParseInt(
                runtime.getSetting('TWITTER_RETRY_LIMIT') ||
                process.env.TWITTER_RETRY_LIMIT,
                5
            ),

            // int in seconds
            TWITTER_POLL_INTERVAL: safeParseInt(
                runtime.getSetting('TWITTER_POLL_INTERVAL') ||
                process.env.TWITTER_POLL_INTERVAL,
                120 // 2m
            ),

            // comma separated string
            TWITTER_TARGET_USERS: parseTargetUsers(
                runtime.getSetting('TWITTER_TARGET_USERS') ||
                process.env.TWITTER_TARGET_USERS
            ),

            TOKIMONSTER_TWITTER_WHITELISTED_USERS: parseTargetUsers(
                runtime.getSetting('TOKIMONSTER_TWITTER_WHITELISTED_USERS') ||
                process.env.TOKIMONSTER_TWITTER_WHITELISTED_USERS
            ),
        };

        return twitterEnvSchema.parse(twitterConfig);
    } catch (error) {
        if (error instanceof ZodError) {
            const errorMessages = error.errors
                .map(err => `${err.path.join('.')}: ${err.message}`)
                .join('\n');
            throw new Error(
                `X/Twitter configuration validation failed:\n${errorMessages}`
            );
        }

        throw error;
    }
}
