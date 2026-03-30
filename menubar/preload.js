const { contextBridge, ipcRenderer } = require('electron');

console.log('Preload script loaded');

contextBridge.exposeInMainWorld('electronAPI', {
  onTerminalOutput: (callback) => {
    console.log('Registered terminal-output listener');
    ipcRenderer.on('terminal-output', (event, data) => {
      console.log('Received terminal output:', data.substring(0, 100));
      callback(data);
    });
  },
  onProgressUpdate: (callback) => {
    ipcRenderer.on('progress-update', (event, data) => callback(data));
  },
  onSyncComplete: (callback) => {
    ipcRenderer.on('sync-complete', (event, data) => callback(data));
  },
  onLoadLog: (callback) => {
    console.log('Registered load-log listener');
    ipcRenderer.on('load-log', (event, data) => {
      console.log('Received load-log, length:', data?.length || 0);
      callback(data);
    });
  }
});

