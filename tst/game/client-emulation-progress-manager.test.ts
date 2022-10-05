import ClientEmulationProgressManager from '../../src/game/client-emulation-progress-manager';
import RegistrationInfo from '../../src/game/registration-info';


let clientEmulationProgressManager: ClientEmulationProgressManager;
beforeEach(() => {

  clientEmulationProgressManager = new ClientEmulationProgressManager();

});

test("waitForPlayersToRegister returns all client registration data once all players have registered after game start", (done) => {


  const controllerClientMappings = ['1', '2', '1337', '3'];
  const registrationInfos: RegistrationInfo[] = controllerClientMappings
    .map((id) => {
      return {
        registrationId: parseInt(id),
        plugin: 0,
        useRawInput: false
      }
    });

  clientEmulationProgressManager.start(controllerClientMappings);

  clientEmulationProgressManager.waitForPlayersToRegister(controllerClientMappings[0])
    .then((regs) => {
      regs.forEach((reg, index) => {
        expect(reg.registrationId > 0).toBe(true);
      });

      expect(regs.length).toBe(registrationInfos.length);

      done();
    });

  registrationInfos.forEach((reg) => {
    clientEmulationProgressManager.registerClient(reg.registrationId.toString());
  });
});

test("waitForPlayersToRegister 'unplugs' controller if client never registers", (done) => {

  const clientId1 = "clientId1";
  const controllerClientMappings = [clientId1, null, null, null];

  clientEmulationProgressManager.start(controllerClientMappings);

  clientEmulationProgressManager.waitForPlayersToRegister(clientId1)
    .then((registrationInfo) => {
      registrationInfo.forEach((reg) => {
        expect(reg).toEqual(null);
      });

      done();
    });
});

async function wait(timeMillis: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => resolve, timeMillis);
  });
}
test("waitForPlayersToRegister returns all client registration data once all players have registered after game pause/resume", (done) => {

  let doneFlag1 = false;
  let doneFlag2 = false;

  const clientId1 = "1337";

  const controllerClientMappings = [clientId1, '2', '9000', '3'];
  const registrationInfos: RegistrationInfo[] = controllerClientMappings
    .map((id) => {
      return {
        registrationId: parseInt(id),
        plugin: 0,
        useRawInput: false
      }
    });

  clientEmulationProgressManager.start(controllerClientMappings);

  clientEmulationProgressManager.waitForPlayersToRegister(clientId1)
    .then((regs) => {
      regs.forEach((reg, index) => {
        expect(reg.registrationId > 1).toBe(true);
      });

      doneFlag1 = true;
      if (doneFlag2) {
        done();
      }
    });

  registrationInfos.forEach((reg) => {
    clientEmulationProgressManager.registerClient(reg.registrationId.toString());
  });

  setTimeout(() => {

    const pauseCounts = clientEmulationProgressManager.tryPause();
    expect(pauseCounts).not.toBe(null);

    controllerClientMappings.forEach((clientId) => {
      clientEmulationProgressManager.confirmPause(clientId, [0, 0, 0, 0]);
    });

    const controllerClientMappingsPostPause = [clientId1, null, null, '3'];
    const didResume = clientEmulationProgressManager
      .tryResume(controllerClientMappingsPostPause);
    expect(didResume).toBe(true);

    clientEmulationProgressManager.waitForPlayersToRegister(clientId1)
      .then((regs) => {
        regs.forEach((reg, index) => {

          if (controllerClientMappingsPostPause[index] !== null) {
            expect(reg.registrationId > 0).toBe(true);
          } else {
            expect(reg).toBe(null);
          }
        });

        doneFlag2 = true;
        if (doneFlag1) {
          done();
        }
      });

  }, 3100);
});

test("updateProgress returns correct lag count when there are no game pauses", (done) => {

  const clientId1 = "1337";
  const clientId2 = "2";

  const controllerClientMappings = [clientId1, clientId2];
  const registrationInfos: RegistrationInfo[] = controllerClientMappings
    .map((id) => {
      return {
        registrationId: parseInt(id),
        plugin: 0,
        useRawInput: false
      }
    });

  clientEmulationProgressManager.start(controllerClientMappings);

  registrationInfos.forEach((reg) => {
    clientEmulationProgressManager.registerClient(reg.registrationId.toString());
  });


  const result1 = clientEmulationProgressManager.updateProgress(clientId1, 1, 5000);

  expect(result1.lag).toBe(0);

  const result2 = clientEmulationProgressManager.updateProgress(clientId2, 1, 2500);

  expect(result2.lag).toBe(2500);

  done();
});


test("updateProgress returns correct lag count with game pause + controller switch", (done) => {

  const clientId1 = "1337";
  const clientId2 = "2";

  const controllerClientMappings = [clientId1, clientId2];
  const registrationInfos: RegistrationInfo[] = controllerClientMappings
    .map((id) => {
      return {
        registrationId: parseInt(id),
        plugin: 0,
        useRawInput: false
      }
    });

  clientEmulationProgressManager.start(controllerClientMappings);

  registrationInfos.forEach((reg) => {
    clientEmulationProgressManager.registerClient(reg.registrationId.toString());
  });

  clientEmulationProgressManager.updateProgress(clientId1, 0, 5000);
  clientEmulationProgressManager.updateProgress(clientId1, 1, 5000);

  setTimeout(() => {
    clientEmulationProgressManager.tryPause();
    clientEmulationProgressManager.confirmPause(clientId1, [5000, 5000, null, null]);

    //p1 switches to p3
    clientEmulationProgressManager.tryResume([null, clientId2, clientId1, null]);

    clientEmulationProgressManager.updateProgress(clientId1, 2, 10000);

    const result1 = clientEmulationProgressManager.updateProgress(clientId2, 0, 2500);
    expect(result1.lag).toBe(2500 + 10000);

    done();
  }, 3100);
});
