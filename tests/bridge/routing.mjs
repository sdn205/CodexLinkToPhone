import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { project, build, root, executable as exe } from '../scripts/paths.mjs';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { WebSocket } from '../fixtures/phone-websocket.mjs';

const run = path.join(build, 'routing', String(Date.now()));
await fs.mkdir(run, { recursive: true });
const token = 'isolated-routing-token';
const pipeName = `codex-phone-routing-${process.pid}`;
const pipeSockets = new Set(), requests = [], controls = [];
let bridge, phone, owner = 'desktop-owner', pipeClients = 0, desktopRevision = 1;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function wait(fn, timeout=15000) { const until=Date.now()+timeout;let error;while(Date.now()<until){try{const r=await fn();if(r)return r;}catch(e){error=e;}await delay(30);}throw error||new Error('Timed out'); }
function encode(m) { const data=Buffer.from(JSON.stringify(m)),head=Buffer.alloc(4);head.writeUInt32LE(data.length);return Buffer.concat([head,data]); }
function snapshot(thread) { return { id:thread,cwd:root,title:'Desktop test',createdAt:Date.now(),updatedAt:Date.now(),threadRuntimeStatus:{type:'idle'},turns:[{turnId:'desktop-turn',status:'completed',turnStartedAtMs:Date.now()-1000,durationMs:10,items:[{id:'desktop-user',type:'userMessage',content:[{type:'text',text:'desktop question'}]},{id:'desktop-answer',type:'agentMessage',text:'desktop answer'}]}] }; }
function publish(socket, thread, change) { socket.write(encode({type:'broadcast',method:'thread-stream-state-changed',version:11,sourceClientId:owner,targetClientIds:['phone'],params:{hostId:'local',conversationId:thread,change}})); }
const pipe = net.createServer(socket => {
  pipeSockets.add(socket);pipeClients++;socket.on('close',()=>pipeSockets.delete(socket));socket.on('error',()=>{});let buffer=Buffer.alloc(0);
  socket.on('data',data=>{
    buffer=Buffer.concat([buffer,data]);
    while(buffer.length>=4&&buffer.length>=4+buffer.readUInt32LE(0)) {
      const size=buffer.readUInt32LE(0),m=JSON.parse(buffer.subarray(4,size+4));buffer=buffer.subarray(size+4);requests.push(m);
      if(m.type==='broadcast'&&m.method==='thread-stream-following-changed'&&m.params.following) {publish(socket,m.params.conversationId,{type:'snapshot',revision:desktopRevision,conversationState:snapshot(m.params.conversationId)});continue;}
      if(m.type!=='request')continue;
      const result=m.method==='initialize'?{clientId:'phone'}:m.method==='thread-owner-discovery'?{}:{result:{turn:{id:'desktop-submitted',startedAt:Date.now()},turnId:'desktop-submitted'}};
      const frame=encode({type:'response',requestId:m.requestId,resultType:'success',handledByClientId:owner,result});socket.write(frame.subarray(0,2));socket.write(frame.subarray(2));
    }
  });
});
await new Promise((r,j)=>{pipe.once('error',j);pipe.listen('\\\\.\\pipe\\'+pipeName,r);});
const proxyState=path.join(run,'instances');await fs.mkdir(proxyState,{recursive:true});
const registry=[];
for(const [id,thread]of [['first','thread-first'],['second','thread-second']]) {
  const control=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>control.once('listening',r));controls.push(control);
  const state={mode:'stdio-tee',instanceId:id,pid:process.pid,upstreamPid:process.pid,initialized:true,upstreamConnected:true,loadedThreadIds:[thread],startedAt:new Date().toISOString(),controlUrl:`ws://127.0.0.1:${control.address().port}`,token:'test-control'};
  state.editorId = id === 'first' ? 'trae' : 'vscode';
  state.editorName = id === 'first' ? 'Trae' : 'VS Code';
  state.workspaceCwd = id === 'first' ? root : path.join(root, 'assistant');
  registry.push(state);control.calls=[];
  control.on('connection',ws=>{
    ws.send(JSON.stringify({type:'hello',state}));
    ws.on('message',data=>{
      const m=JSON.parse(data);control.calls.push(m);
      if(m.type==='get-state')ws.send(JSON.stringify({type:'history',events:[],complete:true}));
      else if(m.id!==undefined) {
        const result=m.method==='model/list'?{data:[{model:'gpt-test',isDefault:true}],nextCursor:null}:m.method==='thread/list'?{data:[{id:thread,name:thread,cwd:root,status:{type:'idle'},updatedAt:Date.now()},{id:'external',name:'external',cwd:root,status:{type:'idle'},updatedAt:Date.now()}],nextCursor:null}:m.method==='thread/resume'||m.method==='thread/read'?{thread:{id:m.params.threadId,name:m.params.threadId,cwd:root,status:{type:'idle'},turns:[]}}:m.method==='turn/start'?{turn:{id:'turn-'+id,startedAt:Date.now()}}:{};
        if (m.method === 'thread/start') result.thread = {id: 'new-' + id, name: 'new-' + id, cwd: m.params.cwd, status: {type: 'idle'}, turns: []};
        ws.send(JSON.stringify({id:m.id,result}));
      }
    });
  });
}
async function registrations(){for(const state of registry){state.updatedAt=new Date().toISOString();await fs.writeFile(path.join(proxyState,state.instanceId+'.json'),JSON.stringify(state));}}
await registrations();const heartbeat=setInterval(()=>registrations().catch(()=>{}),1000);
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const env={...process.env,HOST:'127.0.0.1',PORT:String(port),CODEX_PHONE_REPO_ROOT:root,CODEX_PROXY_REGISTRY:proxyState,CODEX_PHONE_STATE_DIR:path.join(run,'state'),CODEX_PHONE_TOKEN:token,CODEX_PHONE_RELAY_DISABLED:'1',CODEX_PHONE_AUTO_LIFECYCLE:'0',CODEX_PHONE_DESKTOP_PIPE:pipeName};
let output='';
try {
  bridge=spawn(exe,[],{cwd:root,env,stdio:['ignore','pipe','pipe'],windowsHide:true});bridge.stderr.on('data',d=>output+=d);bridge.stdout.on('data',()=>{});
  await wait(async()=>{if(bridge.exitCode!==null)throw new Error(output);const h=await fetch(`http://127.0.0.1:${port}/api/health?token=${token}`).then(r=>r.json());return h.codex.info.instances.filter(i=>i.connected).length===2;});
  phone=new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}&streamProtocol=1`);const frames=[];phone.on('message',d=>frames.push(JSON.parse(d)));phone.on('error',()=>{});await new Promise((r,j)=>{phone.once('open',r);phone.once('error',j);});
  async function open(thread){phone.send(JSON.stringify({type:'thread:open',threadId:thread,requestId:'open-'+thread}));await wait(()=>frames.find(f=>f.type==='thread:open:result'&&f.requestId==='open-'+thread&&f.ok));await delay(150);phone.send(JSON.stringify({type:'state:request'}));return wait(()=>[...frames].reverse().find(f=>f.type==='state'&&f.state.currentThreadId===thread)?.state);}
  let state=await open('thread-first');
  phone.send(JSON.stringify({type:'message:send',requestId:'send-first',threadId:'thread-first',threadRevision:state.threadRevision,text:'first only',images:[]}));
  await wait(()=>frames.find(f=>f.requestId==='send-first'&&f.ok));assert.equal(controls[0].calls.filter(m=>m.method==='turn/start').length,1);assert.equal(controls[1].calls.filter(m=>m.method==='turn/start').length,0);
  state=await open('thread-second');phone.send(JSON.stringify({type:'message:send',requestId:'send-second',threadId:'thread-second',threadRevision:state.threadRevision,text:'second only',images:[]}));
  await wait(()=>frames.find(f=>f.requestId==='send-second'&&f.ok));assert.equal(controls[1].calls.filter(m=>m.method==='turn/start').length,1);
  state=await open('external');
  await wait(()=>requests.some(m=>m.method==='thread-stream-following-changed'&&m.params.conversationId==='external'));
  phone.send(JSON.stringify({type:'state:request'}));await wait(()=>frames.some(f=>f.type==='state'&&f.state.messages.some(m=>matchesMessage(m, 'desktop-answer'))));
  assert.equal(controls.flatMap(c=>c.calls).filter(m=>['thread/resume','turn/start'].includes(m.method)&&m.params?.threadId==='external').length,0);
  phone.send(JSON.stringify({type:'message:send',requestId:'send-desktop',threadId:'external',threadRevision:state.threadRevision,text:'desktop input',images:[]}));
  await wait(()=>frames.some(f=>f.requestId==='send-desktop'&&f.ok));
  const start=requests.find(m=>m.method==='thread-follower-start-turn');assert.equal(start.version,2);assert.equal(start.targetClientId,owner);assert.equal(start.params.turnStart.request.input[0].text,'desktop input');
  desktopRevision++;
  for(const s of pipeSockets)publish(s,'external',{type:'patches',baseRevision:1,revision:desktopRevision,patches:[{op:'replace',path:['turns',0,'items',1,'text'],value:'updated through IPC'}]});
  await wait(async()=>{const s=await fetch(`http://127.0.0.1:${port}/api/status?token=${token}`).then(r=>r.json());return s.messages.some(m=>m.text==='updated through IPC');});
  for(const s of pipeSockets)s.destroy();owner='desktop-reconnected';
  await wait(()=>pipeClients>=2,15000);
  assert.equal(requests.filter(m=>m.method==='thread-follower-start-turn').length,1,'IPC reconnect must never replay a write');
  await open('thread-second');
  phone.send(JSON.stringify({type:'thread:new',requestId:'new-vscode'}));
  await wait(()=>frames.some(f=>f.requestId==='new-vscode'&&f.ok));
  phone.send(JSON.stringify({type:'state:request'}));
  const pending = await wait(()=>[...frames].reverse().find(f=>f.type==='state'&&!f.state.currentThreadId&&f.state.threadSettings?.proxyInstanceId==='second')?.state);
  assert.equal(pending.threadSettings.cwd,path.join(root,'assistant'));
  phone.send(JSON.stringify({type:'message:send',requestId:'first-vscode-message',threadId:'',threadRevision:pending.threadRevision,text:'new VS Code workspace',images:[]}));
  await wait(()=>frames.some(f=>f.requestId==='first-vscode-message'&&f.ok));
  assert.equal(controls[0].calls.filter(m=>m.method==='thread/start').length,0);
  assert.equal(controls[1].calls.find(m=>m.method==='thread/start').params.cwd,path.join(root,'assistant'));
  phone.send(JSON.stringify({type:'thread:new',requestId:'automatic-new'}));
  await wait(()=>frames.some(f=>f.requestId==='automatic-new'&&f.ok));
  const facts={multiInstanceRoutes:'passed',desktopDiscoveryAndFollower:'passed',desktopPatch:'passed',desktopReconnectWithoutDuplicateWrite:'passed',vscodeNewThreadWorkspace:'passed',automaticWindowWithoutSelection:'passed'};
  await fs.writeFile(path.join(run,'results.json'),JSON.stringify(facts,null,2),'utf8');console.log(JSON.stringify(facts,null,2));
} catch(e){console.error(output);throw e;}
finally {
  clearInterval(heartbeat);phone?.terminate();
  if(bridge&&bridge.exitCode===null){const ended=new Promise(r=>bridge.once('exit',r));bridge.kill();await ended;}
  for(const control of controls){for(const ws of control.clients)ws.terminate();await new Promise(r=>control.close(r));}
  for(const s of pipeSockets)s.destroy();await new Promise(r=>pipe.close(r));
}

function matchesMessage(message, sourceId) { return message.id === sourceId || message.meta?.sourceItemId === sourceId; }
