'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('earth', {
  snapshot: (opts) => ipcRenderer.invoke('feed:snapshot', opts),
  probe: (lat, lon) => ipcRenderer.invoke('geo:probe', { lat, lon }),
  search: (q) => ipcRenderer.invoke('geo:search', q),
  locate: () => ipcRenderer.invoke('geo:locate'),
  open: (url) => ipcRenderer.invoke('app:open', url),
  platform: process.platform,
  version: process.env.npm_package_version || '1.0.0',
});
