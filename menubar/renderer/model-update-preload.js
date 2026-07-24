const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('modelNotice', {
  getNotice: () => ipcRenderer.invoke('model-notice:get'),
  sendAction: (action) => ipcRenderer.send('model-notice:action', String(action)),
});
