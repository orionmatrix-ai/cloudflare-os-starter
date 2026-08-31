import RPC_MODULE_URL from "./generated/browser-rpc.js";

// No remote script, fetch, HTML rendering of document content or model call.
export const PILOT_HTML = `<!doctype html><html lang="ja"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OM OAO Knowledge Pilot</title>
<style>body{font:16px system-ui;padding:24px;max-width:820px;color:#163333;background:#f5faf8}button{padding:12px;margin:8px 8px 8px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;padding:16px;border:1px solid #bbb}</style>
<h1>Knowledge synthetic読取評価</h1>
<p>管理者専用・固定文書1件・全体で1回。実Vault／AI呼出し／他サービス送信なし。画面の権限は60秒で失効します。</p>
<p>読取の成否にかかわらず再試行しません。本文は一時表示のみ。読取前に対象を確認してください。</p>
<button id="read" disabled>固定synthetic文書を1回読む</button><button id="receipt">結果記録を確認</button>
<pre id="out">接続確認中</pre>
<script type="module">
import { newMessagePortRpcSession } from ${JSON.stringify(RPC_MODULE_URL)};
const {port1,port2}=new MessageChannel();
window.parent.postMessage({type:'handshake'},'*',[port2]);
const host=newMessagePortRpcSession(port1);
const out=document.getElementById('out'), read=document.getElementById('read');
let expected;
try {expected=await host.ui.describeRead();out.textContent=JSON.stringify(expected,null,2);read.disabled=false;}
catch {out.textContent='HOLD: 認可・設定を確認し、画面を開き直してください。';}
read.onclick=async()=>{read.disabled=true;try{out.textContent=JSON.stringify(await host.ui.readSynthetic(expected.approvalHash),null,2);}catch{out.textContent='HOLD: 読取は完了確認できません。自動再試行しません。結果記録を確認してください。';}};
document.getElementById('receipt').onclick=async()=>{try{out.textContent=JSON.stringify(await host.ui.getReceipt(),null,2);}catch{out.textContent='HOLD: 管理者画面を開き直してください。';}};
</script></html>`;
