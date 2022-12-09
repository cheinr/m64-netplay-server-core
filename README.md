A Typescript netplay server implementation for mupen64plus based on and
extended from [locanmc's original netplay server implementation](https://github.com/simple64/simple64-netplay-server).

# Usage

`m64-netplay-server-core` is meant to be transport-agnostic, meaning you'll need to provide an
implementation of `iconnection-manager.ts` and `iclient-connection.ts` (Make sure to also extend
from `abstract-client-connection`). A websocket-based implementation of this can be found under
`src/examples`.

### To try out the example: (assuming repo is pulled down locally)

1. Build it
```
npm run build
```

2. Start the server
```
node dist/examples/websocket-server.js
```

3. Connect
```
node dist/examples/websocket-client.js
```
