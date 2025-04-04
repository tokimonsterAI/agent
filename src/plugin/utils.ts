import { State } from '@elizaos/core';

interface ClientPayload {
    twitter?: {
        id?: string;
        userId?: string;
        username?: string;
        url?: string;
    };
}

interface TokimonsterState {
    clientPayload?: ClientPayload;

    photos?: Array<{ url: string; }>;
}

export const getTokimonsterState = (state: State): TokimonsterState => state._tokimonsterState || {}; // eslint-disable-line no-underscore-dangle

export const isValidClientPayload = (payload: ClientPayload | undefined | null) => {
    if (!payload) {
        return false;
    }

    if (payload.twitter) {
        return payload.twitter.id && payload.twitter.userId && payload.twitter.url;
    }

    return false;
};
