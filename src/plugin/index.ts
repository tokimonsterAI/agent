import { Plugin } from '@elizaos/core';

import deployToken from './actions/deployToken.ts';

const tokimonsterPlugin: Plugin = {
    name: 'tokimonster',
    description: 'Tokimonster Plugin for Eliza',
    actions: [
        deployToken
    ]
};

export default tokimonsterPlugin;
