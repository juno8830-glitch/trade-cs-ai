'use strict';
const { contextBridge, ipcRenderer } = require('electron');

function on(channel, cb) {
  const listener = (_event, data) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('bridge', {
  mode: 'electron',
  getConfig: () => ipcRenderer.invoke('bridge:getConfig'),
  getAgents: (refresh) => ipcRenderer.invoke('bridge:getAgents', !!refresh),
  api: (payload) => ipcRenderer.invoke('bridge:api', payload),
  suggestStream: (payload) => ipcRenderer.invoke('bridge:suggestStream', payload),
  onFrame: (cb) => on('bridge:frame', cb),
  onPush: (cb) => on('bridge:push', cb),
  onShortcut: (cb) => on('bridge:shortcut', cb),
  getHotkey: () => ipcRenderer.invoke('bridge:getHotkey'),
  onHotkey: (cb) => on('bridge:hotkey', cb),
  retryHotkey: () => ipcRenderer.invoke('bridge:retryHotkey'),
  restart: () => ipcRenderer.invoke('bridge:restart'),
  onRestarted: (cb) => on('bridge:restarted', cb),
  copy: (payload) => ipcRenderer.invoke('bridge:copy', payload),
  copyImage: (payload) => ipcRenderer.invoke('bridge:copyImage', payload),
  readClipboardImage: () => ipcRenderer.invoke('bridge:readClipboardImage'),
  saveImage: (payload) => ipcRenderer.invoke('bridge:saveImage', payload),
  confirmSend: (payload) => ipcRenderer.invoke('bridge:confirmSend', payload),
  logSent: (payload) => ipcRenderer.invoke('bridge:logSent', payload),
  hide: () => ipcRenderer.invoke('bridge:hide'),
  customerList: () => ipcRenderer.invoke('bridge:customerList'),
  customerLoad: (name) => ipcRenderer.invoke('bridge:customerLoad', name),
  customerSave: (profile) => ipcRenderer.invoke('bridge:customerSave', profile),
  customerAppend: (entry) => ipcRenderer.invoke('bridge:customerAppend', entry),
  customerOpen: () => ipcRenderer.invoke('bridge:customerOpen'),
  openManual: () => ipcRenderer.invoke('bridge:openManual'),
  openKbPath: (kind) => ipcRenderer.invoke('bridge:openKbPath', kind),
  openUrl: (url) => ipcRenderer.invoke('bridge:openUrl', url),
});
