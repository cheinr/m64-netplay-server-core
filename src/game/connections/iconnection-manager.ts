//eslint-disable-next-line @typescript-eslint/interface-name-prefix
export default interface IConnectionManager {

  initialize(): Promise<void>;
  addConnectionListener(cb): void;
  addDisconnectListener(cb): void;
}; //eslint-disable-line semi
