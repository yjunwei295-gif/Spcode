/** 作品工具栏专用桥接；创作内容运行在另一个没有此桥接的 WebContentsView。 */
const {contextBridge,ipcRenderer}=require('electron');
const api={
  state:function state(){return ipcRenderer.invoke('artifact:state');},
  layout:function layout(bounds){ipcRenderer.send('artifact:layout',bounds);},
  seek:function seek(time){return ipcRenderer.invoke('artifact:seek',time);},
  refresh:function refresh(){return ipcRenderer.invoke('artifact:refresh');},
  save:function save(format,time){return ipcRenderer.invoke('artifact:save',{format,time});},
  cancel:function cancel(){return ipcRenderer.invoke('artifact:cancel');},
  onStatus:function onStatus(callback){function receive(_event,text){callback(text);}ipcRenderer.on('artifact:status',receive);},
  onUpdated:function onUpdated(callback){function receive(_event,value){callback(value);}ipcRenderer.on('artifact:updated',receive);}
};
contextBridge.exposeInMainWorld('artifactStudio',api);
