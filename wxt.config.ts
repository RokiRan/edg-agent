import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Edg Agent',
    version: '0.1.0',
    description: 'Chat with an AI agent in the side panel to operate your browser.',
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    permissions: ['sidePanel', 'storage', 'activeTab', 'scripting', 'tabs', 'debugger'],
    host_permissions: ['<all_urls>'],
    optional_host_permissions: ['<all_urls>'],
    action: {
      default_icon: {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
        48: 'icons/icon-48.png',
        128: 'icons/icon-128.png',
      },
    },
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