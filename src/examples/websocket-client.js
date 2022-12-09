import { v4 as uuidv4 } from 'uuid';
// Not needed in the browser
import WebSocket from 'ws';

async function connect(hostname, port) {

  const token = uuidv4();
  
  let connectionId;
  let roomControlWS;
  let reliableWS;
  let unreliableWS;
  
  const startConnecting = async () => {
    return new Promise((resolve) => {
      const roomControlUrl = `ws://${hostname}:${port}/room-control`;
      
      roomControlWS = new WebSocket(roomControlUrl);

      roomControlWS.onmessage = (event) => {
        console.log(event);
        const data = JSON.parse(event.data);

        if (data.type === 'game-join-success') {
          connectionId = data.payload.connectionId;
          resolve();
        }
      };

      roomControlWS.onopen = () => {
        console.log('Requesting game join!');
        roomControlWS.send(JSON.stringify({
          type: 'request-game-join',
          payload: {
            playerInfo: { 'name': 'coolin', 'token': token }
          }
        }));
      };
    });
  };

  const finishConnecting = async () => {
    return new Promise((resolve) => {
      if (connectionId === undefined) {
        throw 'No connectionId is set! Did you forget to \'request-game-join\'?';
      }

      const reliableUrl = `ws://${hostname}:${port}/reliable?connectionId=${connectionId}&token=${token}`;
      const unreliableUrl = `ws://${hostname}:${port}/unreliable?connectionId=${connectionId}&token=${token}`;
      
      reliableWS = new WebSocket(reliableUrl);
      unreliableWS = new WebSocket(unreliableUrl);
      reliableWS.binaryType = 'arraybuffer';
      unreliableWS.binaryType = 'arraybuffer';

      reliableWS.onopen = () => {
        if (unreliableWS.readyState === 1) {
          resolve();
        }
      };

      unreliableWS.onopen = () => {
        if (reliableWS.readyState === 1) {
          resolve();
        }
      };
    });
  };

  await startConnecting();
  await finishConnecting();

  return {
    // See abstract-client-connection for how this can be used
    roomControlWS,
    // Pass these into mupen64plus-web
    reliableWS,
    unreliableWS
  };
}

connect('localhost', 2525).then((result) => {
  console.log('Connected: %o', result);
}).catch((err) => {
  console.error('Failed to connect: ', err);
});
