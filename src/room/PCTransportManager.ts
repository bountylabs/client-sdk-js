import { Mutex } from '@livekit/mutex';
import { SignalTarget } from '@livekit/protocol';
import log, { LoggerNames, getLogger } from '../logger';
import PCTransport, { PCEvents } from './PCTransport';
import { roomConnectOptionDefaults } from './defaults';
import { ConnectionError, ConnectionErrorReason } from './errors';
import CriticalTimers from './timers';
import type { LoggerOptions } from './types';
import { sleep } from './utils';

export enum PCTransportState {
  NEW,
  CONNECTING,
  CONNECTED,
  FAILED,
  CLOSING,
  CLOSED,
}

export class PCTransportManager {
  public publisher: PCTransport;

  public subscriber: PCTransport;

  public p2pConnection: PCTransport;

  isP2P: boolean;

  public peerConnectionTimeout: number = roomConnectOptionDefaults.peerConnectionTimeout;

  public get needsPublisher() {
    return this.isPublisherConnectionRequired;
  }

  public get needsSubscriber() {
    return this.isSubscriberConnectionRequired;
  }

  public get currentState() {
    return this.state;
  }

  public onStateChange?: (
    state: PCTransportState,
    pubState: RTCPeerConnectionState,
    subState: RTCPeerConnectionState,
  ) => void;

  public onIceCandidate?: (ev: RTCIceCandidate, target: SignalTarget) => void;

  // TODO merge with onIceCandidate with Signal Target
  public onP2PIceCandidate?: (ev: RTCIceCandidate) => void;

  public onDataChannel?: (ev: RTCDataChannelEvent) => void;

  public onTrack?: (ev: RTCTrackEvent) => void;

  public onPublisherOffer?: (offer: RTCSessionDescriptionInit) => void;

  public onP2POffer?: (offer: RTCSessionDescriptionInit) => void;

  private isPublisherConnectionRequired: boolean;

  private isSubscriberConnectionRequired: boolean;

  private state: PCTransportState;

  private connectionLock: Mutex;

  private remoteOfferLock: Mutex;

  private log = log;

  private loggerOptions: LoggerOptions;
  private rtcConfig : RTCConfiguration;

  constructor(
    rtcConfig: RTCConfiguration,
    subscriberPrimary: boolean,
    loggerOptions: LoggerOptions,
  ) {
    this.log = getLogger(loggerOptions.loggerName ?? LoggerNames.PCManager);
    this.loggerOptions = loggerOptions;

    this.rtcConfig = rtcConfig;

    this.isP2P = false;
    this.p2pConnection = new PCTransport("p2p", this.rtcConfig, this.loggerOptions);
    this.p2pConnection.onIceCandidate = (candidate) => {
      // console.log(`P2P: received ice candidate: ${candidate.candidate}`)
      this.onP2PIceCandidate?.(candidate);
    };

    this.p2pConnection.onTrack = (ev) => {
      if (this.isP2P) {
        this.onTrack?.(ev);
      } else {
        console.log("P2P: received track on p2p connection but not in p2p mode. Ignoring.")
      }
    }

    this.p2pConnection.onOffer = (offer) => {
      this.onP2POffer?.(offer);
    }



    this.isPublisherConnectionRequired = !subscriberPrimary;
    this.isSubscriberConnectionRequired = subscriberPrimary;
    this.publisher = new PCTransport("publisher", rtcConfig, loggerOptions);
    this.subscriber = new PCTransport("subscriber", rtcConfig, loggerOptions);

    // TODO subscribe for p2p
    this.publisher.onConnectionStateChange = this.updateState;
    this.subscriber.onConnectionStateChange = this.updateState;
    this.publisher.onIceConnectionStateChange = this.updateState;
    this.subscriber.onIceConnectionStateChange = this.updateState;
    this.publisher.onSignalingStatechange = this.updateState;
    this.subscriber.onSignalingStatechange = this.updateState;
    this.publisher.onIceCandidate = (candidate) => {
      this.onIceCandidate?.(candidate, SignalTarget.PUBLISHER);
    };
    this.subscriber.onIceCandidate = (candidate) => {
      this.onIceCandidate?.(candidate, SignalTarget.SUBSCRIBER);
    };
    // in subscriber primary mode, server side opens sub data channels.
    this.subscriber.onDataChannel = (ev) => {
      this.onDataChannel?.(ev);
    };
    this.subscriber.onTrack = (ev) => {
      if (!this.isP2P) {
        this.onTrack?.(ev);
      } else {
        console.log("P2P: received track on subscriber connection but in p2p mode. Ignoring.")
      }
    };
    this.publisher.onOffer = (offer) => {
      this.onPublisherOffer?.(offer);
    };

    this.state = PCTransportState.NEW;

    this.connectionLock = new Mutex();
    this.remoteOfferLock = new Mutex();
  }

  private get logContext() {
    return {
      ...this.loggerOptions.loggerContextCb?.(),
    };
  }

  requirePublisher(require = true) {
    this.isPublisherConnectionRequired = require;
    this.updateState();
  }

  requireSubscriber(require = true) {
    this.isSubscriberConnectionRequired = require;
    this.updateState();
  }

  createAndSendPublisherOffer(options?: RTCOfferOptions) {
    return this.publisher.createAndSendOffer(options);
  }

  createAndSendP2POffer(options?: RTCOfferOptions) {
    return this.p2pConnection.createAndSendOffer(options);
  }

  setP2PAnswer(sd: RTCSessionDescriptionInit) {
    console.log("P2P: received P2P answer")
    return this.p2pConnection.setRemoteDescription(sd);
  }

  setPublisherAnswer(sd: RTCSessionDescriptionInit) {
    return this.publisher.setRemoteDescription(sd);
  }

  removeTrack(sender: RTCRtpSender) {
    return this.publisher.removeTrack(sender);
  }

  async close() {
    if (this.publisher && this.publisher.getSignallingState() !== 'closed') {
      const publisher = this.publisher;
      for (const sender of publisher.getSenders()) {
        try {
          // TODO: react-native-webrtc doesn't have removeTrack yet.
          if (publisher.canRemoveTrack()) {
            publisher.removeTrack(sender);
          }
        } catch (e) {
          this.log.warn('could not removeTrack', { ...this.logContext, error: e });
        }
      }
    }
    await Promise.all([this.publisher.close(), this.subscriber.close()]);
    this.updateState();
  }

  async triggerIceRestart() {
    this.subscriber.restartingIce = true;
    // only restart publisher if it's needed
    if (this.needsPublisher) {
      await this.createAndSendPublisherOffer({ iceRestart: true });
    }
  }

  async addIceCandidate(candidate: RTCIceCandidateInit, target: SignalTarget) {
    if (target === SignalTarget.PUBLISHER) {
      await this.publisher.addIceCandidate(candidate);
    } else {
      await this.subscriber.addIceCandidate(candidate);
    }
  }

  async addP2PIceCandidate(candidate: RTCIceCandidateInit) {
    await this.p2pConnection.addIceCandidate(candidate);
  }

  async createSubscriberAnswerFromOffer(sd: RTCSessionDescriptionInit) {
    this.log.debug('received server offer', {
      ...this.logContext,
      RTCSdpType: sd.type,
      sdp: sd.sdp,
      signalingState: this.subscriber.getSignallingState().toString(),
    });
    const unlock = await this.remoteOfferLock.lock();
    try {
      await this.subscriber.setRemoteDescription(sd);

      // answer the offer
      const answer = await this.subscriber.createAndSetAnswer();
      return answer;
    } finally {
      unlock();
    }
  }

  async createP2PAnswerFromOffer(sd: RTCSessionDescriptionInit, callback: () => Promise<void>) {
    console.log(`P2P: received P2P offer: ${sd.sdp}`)
    const unlock = await this.remoteOfferLock.lock();
    try {
      await this.p2pConnection.setRemoteDescription(sd);
      await callback()

      // answer the offer
      const answer = await this.p2pConnection.createAndSetAnswer();
      return answer;
    } finally {
      unlock();
    }
  }


  updateConfiguration(config: RTCConfiguration, iceRestart?: boolean) {
    this.publisher.setConfiguration(config);
    this.subscriber.setConfiguration(config);
    if (iceRestart) {
      this.triggerIceRestart();
    }
  }

  async ensurePCTransportConnection(abortController?: AbortController, timeout?: number) {
    const unlock = await this.connectionLock.lock();
    try {
      if (
        this.isPublisherConnectionRequired &&
        this.publisher.getConnectionState() !== 'connected' &&
        this.publisher.getConnectionState() !== 'connecting'
      ) {
        this.log.debug('negotiation required, start negotiating', this.logContext);
        this.publisher.negotiate();
      }
      await Promise.all(
        this.requiredTransports?.map((transport) =>
          this.ensureTransportConnected(transport, abortController, timeout),
        ),
      );
    } finally {
      unlock();
    }
  }

  async negotiate(abortController: AbortController) {
    return new Promise<void>(async (resolve, reject) => {
      const negotiationTimeout = setTimeout(() => {
        reject('negotiation timed out');
      }, this.peerConnectionTimeout);

      const abortHandler = () => {
        clearTimeout(negotiationTimeout);
        reject('negotiation aborted');
      };

      abortController.signal.addEventListener('abort', abortHandler);
      this.publisher.once(PCEvents.NegotiationStarted, () => {
        if (abortController.signal.aborted) {
          return;
        }
        this.publisher.once(PCEvents.NegotiationComplete, () => {
          clearTimeout(negotiationTimeout);
          resolve();
        });
      });

      await this.publisher.negotiate((e) => {
        clearTimeout(negotiationTimeout);
        reject(e);
      });
    });
  }

  addPublisherTransceiver(track: MediaStreamTrack, transceiverInit: RTCRtpTransceiverInit) {
    if (this.isP2P) {
      console.log("P2P: adding transceiver to p2p connection")
      return this.p2pConnection.addTransceiver(track, transceiverInit);
    } else {
      console.log("P2P: adding transceiver to publisher connection")
      return this.publisher.addTransceiver(track, transceiverInit);
    }
  }

  addPublisherTrack(track: MediaStreamTrack) {
    if (this.isP2P) {
      console.log("P2P: adding track to p2p connection")
      return this.p2pConnection.addTrack(track);
    } else {
      console.log("P2P: adding track to publisher connection")
      return this.publisher.addTrack(track);
    }
  }

  createPublisherDataChannel(label: string, dataChannelDict: RTCDataChannelInit) {
    return this.publisher.createDataChannel(label, dataChannelDict);
  }

  /**
   * Returns the first required transport's address if no explicit target is specified
   */
  getConnectedAddress(target?: SignalTarget) {
    if (target === SignalTarget.PUBLISHER) {
      return this.publisher.getConnectedAddress();
    } else if (target === SignalTarget.SUBSCRIBER) {
      return this.publisher.getConnectedAddress();
    }
    return this.requiredTransports[0].getConnectedAddress();
  }

  private get requiredTransports() {
    const transports: PCTransport[] = [];
    if (this.isPublisherConnectionRequired) {
      transports.push(this.publisher);
    }
    if (this.isSubscriberConnectionRequired) {
      transports.push(this.subscriber);
    }
    return transports;
  }

  private updateState = () => {
    const previousState = this.state;

    const connectionStates = this.requiredTransports.map((tr) => tr.getConnectionState());
    if (connectionStates.every((st) => st === 'connected')) {
      this.state = PCTransportState.CONNECTED;
    } else if (connectionStates.some((st) => st === 'failed')) {
      this.state = PCTransportState.FAILED;
    } else if (connectionStates.some((st) => st === 'connecting')) {
      this.state = PCTransportState.CONNECTING;
    } else if (connectionStates.every((st) => st === 'closed')) {
      this.state = PCTransportState.CLOSED;
    } else if (connectionStates.some((st) => st === 'closed')) {
      this.state = PCTransportState.CLOSING;
    } else if (connectionStates.every((st) => st === 'new')) {
      this.state = PCTransportState.NEW;
    }

    if (previousState !== this.state) {
      this.log.debug(
        `pc state change: from ${PCTransportState[previousState]} to ${
          PCTransportState[this.state]
        }`,
        this.logContext,
      );
      this.onStateChange?.(
        this.state,
        this.publisher.getConnectionState(),
        this.subscriber.getConnectionState(),
      );
    }
  };

  private async ensureTransportConnected(
    pcTransport: PCTransport,
    abortController?: AbortController,
    timeout: number = this.peerConnectionTimeout,
  ) {
    const connectionState = pcTransport.getConnectionState();
    if (connectionState === 'connected') {
      return;
    }

    return new Promise<void>(async (resolve, reject) => {
      const abortHandler = () => {
        this.log.warn('abort transport connection', this.logContext);
        CriticalTimers.clearTimeout(connectTimeout);

        reject(
          new ConnectionError(
            'room connection has been cancelled',
            ConnectionErrorReason.Cancelled,
          ),
        );
      };
      if (abortController?.signal.aborted) {
        abortHandler();
      }
      abortController?.signal.addEventListener('abort', abortHandler);

      const connectTimeout = CriticalTimers.setTimeout(() => {
        abortController?.signal.removeEventListener('abort', abortHandler);
        reject(
          new ConnectionError(
            'could not establish pc connection',
            ConnectionErrorReason.InternalError,
          ),
        );
      }, timeout);

      while (this.state !== PCTransportState.CONNECTED) {
        await sleep(50); // FIXME we shouldn't rely on `sleep` in the connection paths, as it invokes `setTimeout` which can be drastically throttled by browser implementations
        if (abortController?.signal.aborted) {
          reject(
            new ConnectionError(
              'room connection has been cancelled',
              ConnectionErrorReason.Cancelled,
            ),
          );
          return;
        }
      }
      CriticalTimers.clearTimeout(connectTimeout);
      abortController?.signal.removeEventListener('abort', abortHandler);
      resolve();
    });
  }

  switchP2P() {
    this.isP2P = true;
  }

  switchSFU() {
    this.isP2P = false;
    this.p2pConnection.close();
  }
}