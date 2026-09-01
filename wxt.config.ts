import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Edg Agent',
    version: '0.1.0',
    description: 'Chat with an AI agent in the side panel to operate your browser.',
    permissions: ['sidePanel', 'storage', 'activeTab', 'scripting', 'tabs'],
    action: {},
    commands: {
      'toggle-side-panel': {
        suggested_key: {
          default: 'Alt+E',
        },
        description: 'Toggle the Edg Agent side panel',
      },
    },
  },
});