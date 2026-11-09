import { addListener } from '@mantou/gem/lib/utils';
import { agentdeckStore } from './store';

// iPad (except mini in portrait), unfolded foldables and dual-screen devices spanning the hinge; phones in landscape are too short.
const wideQuery = matchMedia('(min-width: 800px) and (min-height: 500px), (horizontal-viewport-segments: 2)');

export const layoutStore = createStore({ wide: wideQuery.matches });

addListener(wideQuery, 'change', () => layoutStore({ wide: wideQuery.matches }));

/** The session list sits in a sidebar beside the global Stack, see `agentdeck-sidebar`. */
export const isSplitView = () => layoutStore.wide && Boolean(agentdeckStore.settings.relayId);
