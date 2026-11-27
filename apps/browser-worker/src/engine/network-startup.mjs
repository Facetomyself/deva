// Chromium emits a fixed browser-process warning when the NetworkService connection
// is lost and it starts a replacement. Match the source tag and message (not an
// error from arbitrary page JS). Retain only positions in two constants and a count.
const file = Buffer.from('network_service_instance_impl.cc');
const message = Buffer.from('] Network service crashed or was terminated, restarting service.');
const limit = 256 * 1024;

export function observeNetworkRestarts(stream) {
  let bytes=0, count=0, matched=0, digits=0, active=true, paren=false, phase='file';
  function reset(byte) {phase='file';matched=byte===file[0]?1:0;digits=0;paren=false;}
  function feed(chunk) {
    if(!active || count>=32 || bytes>=limit) return;
    for(const byte of chunk) {
      if(++bytes>limit || count>=32) break;
      if(phase==='file') {
        if(byte===file[matched]){if(++matched===file.length){phase='separator';matched=0;}}
        else reset(byte);
      } else if(phase==='separator') {
        if(byte===58 || byte===40){phase='line';paren=byte===40;}
        else reset(byte);
      } else if(phase==='line') {
        if(byte>=48 && byte<=57 && digits<9){digits++;continue;}
        if(digits && paren && byte===41){phase='message';matched=0;}
        else if(digits && !paren && byte===message[0]){phase='message';matched=1;}
        else reset(byte);
      } else if(phase==='message') {
        if(byte===message[matched]){if(++matched===message.length){count++;reset(-1);}}
        else reset(byte);
      }
    }
  }
  stream?.on('data',feed);
  return {
    stop() {active=false;stream?.off('data',feed);return count;}
  };
}
