import RegistrationInfo from './registration-info';
import CheckpointState from './checkpoint-state';

interface ProgressCheckpoint {
  pauseCounts: number[];
  state: CheckpointState;

  // Clients that were close to the original
  // pause target that we want to synchronize.
  //
  // Clients that are further behind are assumed
  // to be able to pause on whatever input counts
  // we synchronize to
  clientsToSynchronizePauseFor: string[];
  resumeTimeMillis: number;

  // Shows us who's controlling what controllers
  controllerToClientMappings?: (string | null)[];
}

interface PauseConfirmResult {
  clientCanInstantResume: boolean;
  countsToResynchronizeOn: number[] | null;
  lag: number | null;
}

interface UpdateProgressResult {
  countsToPauseOn: number[] | null;
  lag: number | null;
}

interface BasicMap<T> {
  [K: string]: T;
}

interface ClientProgressInfo {
  counts: number[];
  lastProgressCheckpoint: number;
  nextProgressCheckpointSignaled: boolean;
  isConnected: boolean;
  registrationInfo?: RegistrationInfo;
  lag: number;
  lastLagCheckTime: number;
}

// Assuming 60 inputs per second
const PROGRESS_FACTOR_SYNCHRONIZATION_THRESHOLD = 60 * 30;
const MINIMUM_RESUME_TIME_MILLIS = 1000 * 3;

const LAG_CHECK_TIMEOUT_MILLIS = 3000;
const LAG_NOTIFICATION_THRESHOLD = 60;

class ClientEmulationProgressManager {

  private readonly progressCheckpoints: ProgressCheckpoint[] = [];
  private readonly progressMappings: BasicMap<ClientProgressInfo> = {};
  private readonly leadCount: number[] = [-1, -1, -1, -1];

  public updateProgress(clientId: string,
    playerNumber: number,
    inputCount: number): UpdateProgressResult {

    const updateProgressResult: UpdateProgressResult = {
      countsToPauseOn: null,
      lag: null
    };

    const progressInfo = this.getOrCreateProgressInfo(clientId);

    progressInfo.counts[playerNumber] = inputCount;

    if (this.leadCount[playerNumber] < inputCount) {
      this.leadCount[playerNumber] = inputCount;
    }

    const maybeLastProgressCheckpoint = this.progressCheckpoints[progressInfo.lastProgressCheckpoint];
    if (maybeLastProgressCheckpoint) {
      if (CheckpointState.RESUMED !== maybeLastProgressCheckpoint.state) {

        if (maybeLastProgressCheckpoint.pauseCounts[playerNumber] < progressInfo.counts[playerNumber]) {

          // TODO - Client should have paused by now. Let's remind them?
          console.error('Unexpected State! - Client has [%s] progress further than the current game pause',
            clientId);
        }
      } else {

        const nextProgressCheckpointAvailableToClient = !maybeLastProgressCheckpoint
          || progressInfo.counts[playerNumber] > maybeLastProgressCheckpoint.pauseCounts[playerNumber];

        if (!progressInfo.nextProgressCheckpointSignaled && nextProgressCheckpointAvailableToClient) {

          const maybeNextProgressCheckpoint = this.progressCheckpoints[progressInfo.lastProgressCheckpoint + 1];

          if (maybeNextProgressCheckpoint) {
            updateProgressResult.countsToPauseOn = maybeNextProgressCheckpoint.pauseCounts;
            progressInfo.nextProgressCheckpointSignaled = true;
          }
        }
      }
    }

    const now = Date.now();
    if (now - progressInfo.lastLagCheckTime > LAG_CHECK_TIMEOUT_MILLIS) {

      const lag = this.getClientLag(clientId);

      progressInfo.lastLagCheckTime = now;

      if (lag >= LAG_NOTIFICATION_THRESHOLD
        || (lag < LAG_NOTIFICATION_THRESHOLD && (progressInfo.lag === -1 || progressInfo.lag >= LAG_NOTIFICATION_THRESHOLD))) {

        updateProgressResult.lag = lag;
        progressInfo.lag = lag;
      }
    }

    return updateProgressResult;
  }

  public getCurrentPlayerNumberForClient(clientId: string): number {

    const lastProgressCheckpointIndex = this.getOrCreateProgressInfo(clientId).lastProgressCheckpoint;

    let lastProgressCheckpoint = this.progressCheckpoints[lastProgressCheckpointIndex];

    if (lastProgressCheckpoint.state !== CheckpointState.RESUMED) {
      lastProgressCheckpoint = this.progressCheckpoints[lastProgressCheckpointIndex - 1];
    }

    if (lastProgressCheckpoint && lastProgressCheckpoint.controllerToClientMappings != undefined) {

      for (let i = 0; i < lastProgressCheckpoint.controllerToClientMappings.length; i++) {
        const mappedClientId = lastProgressCheckpoint.controllerToClientMappings[i];
        if (mappedClientId === clientId) {
          return i;
        }
      }
    }

    console.log('This shouldn\'t really happen!');

    return -1;
  }

  public registerClient(clientId: string): number {

    const registrationId = Math.floor(Math.random() * (Math.pow(2, 31) - 1));
    const registrationInfo: RegistrationInfo = {
      registrationId,
      plugin: 1,
      useRawInput: false
    };

    this.getOrCreateProgressInfo(clientId).registrationInfo = Object.assign({},
      registrationInfo);

    return registrationId;
  }

  public updateClientRegistrationInfo(clientId: string, registrationInfo: RegistrationInfo): void {

    this.getOrCreateProgressInfo(clientId).registrationInfo = Object.assign({},
      registrationInfo);
  }

  public async waitForPlayersToRegister(clientId: string): Promise<(RegistrationInfo | null)[]> {

    const progressCheckpointIndex = this.getOrCreateProgressInfo(clientId).lastProgressCheckpoint;
    const progressCheckpoint = Object.assign({}, this.progressCheckpoints[progressCheckpointIndex]);

    return new Promise((resolve, reject) => {

      let isFailed = false;
      const failTimeout = setTimeout(() => {
        // Shouldn't ever happen
        isFailed = true;
        console.error('Failed to wait for players to register');
        reject('Failed to wait for players to register');
      }, 10000);

      const unplugControllersForPlayersWhoFailedToRegisterTimeout = setTimeout(() => {

        if (!progressCheckpoint || !progressCheckpoint.controllerToClientMappings) {
          clearTimeout(failTimeout);
          reject('Illegal state: The last progress checkpoint is either missing or doesn\'t have controllerMappings present');
          return;
        }

        const controllerToClientMappings = progressCheckpoint.controllerToClientMappings;

        controllerToClientMappings.forEach((clientId, controllerIndex) => {
          if (clientId) {
            if (!this.getOrCreateProgressInfo(clientId).registrationInfo) {
              console.log('Unplugging controller %d', controllerIndex);
              controllerToClientMappings[controllerIndex] = null;
            }
          }
        });
      }, 3000);

      const interval = setInterval(() => {

        if (isFailed) {
          clearInterval(interval);
        }

        if (!progressCheckpoint || !progressCheckpoint.controllerToClientMappings) {

          isFailed = true;
          reject('Illegal state: The last progress checkpoint is either missing or doesn\'t have controllerMappings present');
          return;
        }

        const allPlayersRegistered = progressCheckpoint.controllerToClientMappings.every((maybeClientId) => {
          return maybeClientId === null || this.getOrCreateProgressInfo(maybeClientId).registrationInfo !== undefined;
        });

        if (allPlayersRegistered) {
          const registrationData = progressCheckpoint.controllerToClientMappings.map((maybeClientId) => {
            return maybeClientId
              ? this.getOrCreateProgressInfo(maybeClientId).registrationInfo ?? null
              : null;
          });

          console.log('RegistrationData: %o', registrationData);

          resolve(registrationData);

          clearInterval(interval);
          clearTimeout(unplugControllersForPlayersWhoFailedToRegisterTimeout);
          clearTimeout(failTimeout);
        }
      }, 100);
    });
  }

  public start(controllerToClientMappings: (string | null)[]): void {
    if (this.progressCheckpoints.length > 0) {
      throw 'Invalid state: can\'t start game that already has checkpoints present';
    }

    this.progressCheckpoints.push({
      pauseCounts: [0, 0, 0, 0],
      state: CheckpointState.RESUMED,
      clientsToSynchronizePauseFor: [],
      resumeTimeMillis: Date.now(),
      controllerToClientMappings
    });
  }

  public tryPause(): number[] | null {

    let pauseTargets: number[] | null = null;
    const lastGamePause = this.progressCheckpoints[this.progressCheckpoints.length - 1];

    if (!lastGamePause || (CheckpointState.RESUMED === lastGamePause.state
      && Date.now() - lastGamePause.resumeTimeMillis >= MINIMUM_RESUME_TIME_MILLIS)) {
      const pauseTargetCounts = this.leadCount.slice();

      const pauseTargetProgressFactor = pauseTargetCounts.reduce((acc, cv) => {
        return acc + cv;
      });

      const clientsToSynchronizePauseFor = Object.entries(this.progressMappings).filter((entry) => {
        const progressCounts = entry[1].counts;
        const isConnected = entry[1].isConnected;

        const progressFactor = progressCounts.reduce((acc, cv) => acc + cv);
        return isConnected
          && (pauseTargetProgressFactor < progressFactor
            || (pauseTargetProgressFactor - progressFactor) < PROGRESS_FACTOR_SYNCHRONIZATION_THRESHOLD);

      }).map((entry) => entry[0]);

      const gamePause: ProgressCheckpoint = {
        pauseCounts: pauseTargetCounts,
        state: CheckpointState.PENDING_PLAYER_PAUSE_CONFIRM,
        clientsToSynchronizePauseFor,
        resumeTimeMillis: Date.now()
      };

      this.progressCheckpoints.push(gamePause);

      pauseTargets = pauseTargetCounts.slice();
    }

    console.log('tryPause result: %o, %o', pauseTargets, this.progressCheckpoints);

    return pauseTargets;
  }


  private getOrCreateProgressInfo(clientId: string): ClientProgressInfo {
    if (!(clientId in this.progressMappings)) {
      this.progressMappings[clientId] = {
        counts: [-1, -1, -1, -1],
        lastProgressCheckpoint: 0,
        nextProgressCheckpointSignaled: false,
        isConnected: true,
        lag: -1,
        lastLagCheckTime: 0
      };
    }
    return this.progressMappings[clientId];
  }

  public confirmPause(clientId: string, actualPauseCounts: number[]): PauseConfirmResult {

    const gamePauseIndex = this.findGamePauseIndexForPauseCounts(actualPauseCounts);

    const clientProgress = this.getOrCreateProgressInfo(clientId);
    clientProgress.lastProgressCheckpoint = gamePauseIndex;
    clientProgress.counts = actualPauseCounts;
    clientProgress.nextProgressCheckpointSignaled = false;


    if (gamePauseIndex === -1) {
      throw 'Can\'t confirm game pause that doesn\'t exist!';
    }

    const gamePause = this.progressCheckpoints[gamePauseIndex];

    if (CheckpointState.RESUMED === gamePause.state) {

      return {
        clientCanInstantResume: true,
        countsToResynchronizeOn: null,
        lag: null
      };
    }

    const checkPauseStateResult = this.checkPauseState();

    if (!checkPauseStateResult.countsToResynchronizeOn) {
      if (clientProgress.lag > LAG_NOTIFICATION_THRESHOLD) {

        const lag = this.getClientLag(clientId);
        checkPauseStateResult.lag = lag;
        clientProgress.lag = lag;
      }
    }

    return checkPauseStateResult;
  }

  private checkPauseState(): PauseConfirmResult {

    const lastGamePause = this.progressCheckpoints[this.progressCheckpoints.length - 1];

    if (!lastGamePause) {
      throw 'Can\'t confirm game pause that doesn\'t exist!';
    }

    if (CheckpointState.RESUMED === lastGamePause.state) {
      return {
        clientCanInstantResume: false,
        countsToResynchronizeOn: null,
        lag: null
      };
    }

    const allRequiredClientsPaused = lastGamePause.clientsToSynchronizePauseFor.every((clientId) => {

      const clientProgress = this.getOrCreateProgressInfo(clientId);

      return clientProgress.lastProgressCheckpoint === this.progressCheckpoints.length - 1;
    });

    if (!allRequiredClientsPaused) {
      console.log('Still waiting for clients to pause!');
      return {
        clientCanInstantResume: false,
        countsToResynchronizeOn: null,
        lag: null
      };
    }

    console.log('All connections paused! Checking if adjustments are needed...');

    const uniquePauseCounts = lastGamePause.clientsToSynchronizePauseFor.map((clientId) => {
      return this.getOrCreateProgressInfo(clientId).counts.slice();
    }).filter((pauseCounts, index, self) => {
      return index === self.findIndex((resultCounts) => {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return pauseCounts.every((count, index) => resultCounts![index] === count);
      });
    });

    console.log('uniquePauseCounts: %o; lastGamePause: %o', uniquePauseCounts, lastGamePause.pauseCounts);

    if (uniquePauseCounts.length > 1) {

      console.log('Multiple unique pause counts detected: [%o]! Asking players to pause at the lead count.', uniquePauseCounts);

      lastGamePause.state = CheckpointState.PENDING_PAUSE_ADJUSTMENT;

      let maxCount: number[] = [-1, -1, -1, -1];

      uniquePauseCounts.forEach((counts) => {

        let shouldBeNewMax = true;

        if (counts === undefined) {
          throw `One of the uniquePauseCounts is undefined!. UniquePauseCounts=${uniquePauseCounts}`;
        }

        counts.forEach((count, index) => {
          if (count < maxCount[index]) {
            shouldBeNewMax = false;
          }
        });

        if (shouldBeNewMax) {
          maxCount = counts;
        }
      });

      console.log('New count to pause at: %o', maxCount);
      lastGamePause.pauseCounts = maxCount;

      lastGamePause.state = CheckpointState.PENDING_PLAYER_PAUSE_CONFIRM;

      return {
        clientCanInstantResume: false,
        countsToResynchronizeOn: maxCount,
        lag: null
      };

    } else {
      lastGamePause.state = CheckpointState.PAUSED;
      lastGamePause.pauseCounts = uniquePauseCounts[0];
      return {
        clientCanInstantResume: false,
        countsToResynchronizeOn: null,
        lag: null
      };
    }
  }

  public tryResume(controllerToClientMappings: (string | null)[]): boolean {

    let didResume: boolean;
    const lastGamePause = this.progressCheckpoints[this.progressCheckpoints.length - 1];

    if (lastGamePause && CheckpointState.PAUSED === lastGamePause.state) {

      lastGamePause.state = CheckpointState.RESUMED;
      lastGamePause.resumeTimeMillis = Date.now();
      lastGamePause.controllerToClientMappings = controllerToClientMappings;
      didResume = true;
    } else {
      didResume = false;
    }

    return didResume;
  }

  public isPaused(): boolean {
    const lastGamePause = this.progressCheckpoints[this.progressCheckpoints.length - 1];

    return (lastGamePause && CheckpointState.PAUSED === lastGamePause.state);
  }

  public getClientProgressInfo(clientId: string): ClientProgressInfo {
    return this.getOrCreateProgressInfo(clientId);
  }

  public getClientLag(clientId: string): number {

    const currentClientCounts = this.getOrCreateProgressInfo(clientId).counts;
    const lastProgressCheckpointIndex = this.getOrCreateProgressInfo(clientId).lastProgressCheckpoint;

    let lag = 0;

    for (let i = lastProgressCheckpointIndex; i < this.progressCheckpoints.length; i++) {

      const currentProgressCheckpoint = this.progressCheckpoints[i];

      const activeControllers: number[] = [];

      if (!currentProgressCheckpoint.controllerToClientMappings) {
        // checkpoint is in paused state, no further 'lag' to record
        break;
      }

      currentProgressCheckpoint.controllerToClientMappings.forEach((val, index) => {
        if (val !== null) {
          activeControllers.push(index);
        }
      });

      if (this.progressCheckpoints[i + 1]) {
        const nextProgressCheckpoint = this.progressCheckpoints[i + 1];

        if (lastProgressCheckpointIndex === i) {
          // Assumes there should always be at least one controller plugged in
          lag += (nextProgressCheckpoint.pauseCounts[activeControllers[0]] - currentClientCounts[activeControllers[0]]);
        } else {
          lag += (nextProgressCheckpoint.pauseCounts[activeControllers[0]] - currentProgressCheckpoint.pauseCounts[activeControllers[0]]);
        }
      } else {

        let maxLeadCountController = activeControllers[0];
        let maxLeadCount = this.leadCount[maxLeadCountController];

        activeControllers.forEach((controller) => {
          if (this.leadCount[controller] > maxLeadCount) {
            maxLeadCount = this.leadCount[controller];
            maxLeadCountController = controller;
          }
        });

        if (lastProgressCheckpointIndex === i) {
          // Assumes there should always be at least one controller plugged in
          lag += (maxLeadCount - currentClientCounts[maxLeadCountController]);
        } else {
          lag += (maxLeadCount - currentProgressCheckpoint.pauseCounts[maxLeadCountController]);
        }
      }
    }

    return lag;
  }

  public getCurrentProgressCheckpointForClient(clientId: string): ProgressCheckpoint | null {

    if (this.progressCheckpoints.length === 0) {
      return null;
    }

    const lastProgressCheckpointIndex = this.getOrCreateProgressInfo(clientId).lastProgressCheckpoint;

    return this.progressCheckpoints[lastProgressCheckpointIndex];
  }

  public onClientDisconnect(clientId: string): PauseConfirmResult {
    const maybeLastProgressCheckpoint = this.progressCheckpoints[this.progressCheckpoints.length - 1];

    const maybeClientProgressInfo = this.progressMappings[clientId];

    if (maybeClientProgressInfo) {
      maybeClientProgressInfo.isConnected = false;
    }

    if (maybeLastProgressCheckpoint && CheckpointState.RESUMED !== maybeLastProgressCheckpoint.state) {
      maybeLastProgressCheckpoint.clientsToSynchronizePauseFor = maybeLastProgressCheckpoint.clientsToSynchronizePauseFor
        .filter((c) => c !== clientId);

      return this.checkPauseState();
    } else {
      return {
        clientCanInstantResume: false,
        countsToResynchronizeOn: null,
        lag: null
      };
    }
  }

  private findGamePauseIndexForPauseCounts(queryCounts: number[]): number {
    let resultIndex = -1;

    console.log('Finding pause for query: %o. pauses=%o', queryCounts, this.progressCheckpoints);
    for (let i = 0; i < this.progressCheckpoints.length; i++) {

      const gamePause = this.progressCheckpoints[i];

      let pauseCountHasBeenReached = true;

      for (let playerIndex = 0; playerIndex < 4; playerIndex++) {

        const queryCount = queryCounts[playerIndex];
        const pauseCount = gamePause.pauseCounts[playerIndex];

        if (pauseCount !== -1 && queryCount < pauseCount) {
          pauseCountHasBeenReached = false;
        }
      }

      if (!pauseCountHasBeenReached) {
        break;
      }

      resultIndex = i;
    }

    return resultIndex;
  }

}

export default ClientEmulationProgressManager;
