'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const subscribe = (channel, handler) => {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('meloPet', {
  state: () => ipcRenderer.invoke('melo:state'),
  send: text => ipcRenderer.invoke('melo:send', text),
  stop: () => ipcRenderer.invoke('melo:stop'),
  hide: () => ipcRenderer.invoke('melo:hide'),
  permission: (id, decision, confirmInput = '') => ipcRenderer.invoke('melo:permission', id, decision, confirmInput),
  openLink: url => ipcRenderer.invoke('melo:open-link', url),
  onSnapshot: handler => subscribe('melo:snapshot', handler),
  onEvent: handler => subscribe('melo:event', handler),
  onFocus: handler => subscribe('melo:focus', handler),
});
