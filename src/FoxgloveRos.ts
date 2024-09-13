import { parseRos2idl } from '@foxglove/ros2idl-parser';
import { parse } from '@foxglove/rosmsg';
import {
  MessageReader as Ros1MessageReader,
  MessageWriter as Ros1MessageWriter,
} from '@foxglove/rosmsg-serialization';
import {
  MessageReader as Ros2MessageReader,
  MessageWriter as Ros2MessageWriter,
} from '@foxglove/rosmsg2-serialization';
import {
  type Channel,
  type ConnectionGraphUpdate,
  FoxgloveClient,
  type MessageData,
  type ParameterValues,
  type Service,
  type ServiceCallFailure,
  type ServiceCallResponse,
} from '@foxglove/ws-protocol';
import WebSocket from 'isomorphic-ws';
import { Ros } from 'roslib';

class FoxgloveSocket {
  #client: FoxgloveClient;
  #ros: Ros & { isConnected: boolean };
  #isRos2: boolean;

  // Message Readers / Writers
  #messageReaders = new Map<string, Ros1MessageReader | Ros2MessageReader>();
  #messageWriters = new Map<string, Ros1MessageWriter | Ros2MessageWriter>();

  // Channels
  #channelsById = new Map<number, Channel>();
  #channelsByName = new Map<string, Channel>();

  // Services
  #servicesById = new Map<number, Service>();
  #servicesByName = new Map<string, Service>();

  #unadvertiseByName = new Map<string, () => void>();
  #publishByName = new Map<string, Promise<(msg: unknown) => void>>();
  #unsubscribeByName = new Map<string, () => void>();

  #callId = 0;

  constructor(url: string, ros: Ros, isRos2 = true) {
    this.#client = new FoxgloveClient({
      ws: new WebSocket(url, [FoxgloveClient.SUPPORTED_SUBPROTOCOL]),
    });
    this.#ros = ros;
    this.#isRos2 = isRos2;

    // topics
    this.#client.on('advertise', (channels) => {
      for (const channel of channels) {
        this.#channelsById.set(channel.id, channel);
        this.#channelsByName.set(channel.topic, channel);
      }
    });
    this.#client.on('unadvertise', (channelIds) => {
      for (const channelId of channelIds) {
        const channel = this.#channelsById.get(channelId);
        if (channel) {
          this.#channelsById.delete(channel.id);
          this.#channelsByName.delete(channel.topic);
        }
      }
    });

    // services
    this.#client.on('advertiseServices', (services) => {
      for (const service of services) {
        this.#servicesById.set(service.id, service);
        this.#servicesByName.set(service.name, service);
      }
    });
    this.#client.on('unadvertiseServices', (serviceIds) => {
      for (const serviceId of serviceIds) {
        const service = this.#servicesById.get(serviceId);
        if (service) {
          this.#servicesById.delete(service.id);
          this.#servicesByName.delete(service.name);
        }
      }
    });

    // roslib
    this.#client.on('open', () => {
      this.#ros.isConnected = true;
      this.#ros.emit('connection', undefined);
    });

    this.#client.on('close', (event) => {
      this.#ros.isConnected = false;
      this.#ros.emit('close', event);
    });

    this.#client.on('error', (event) => {
      this.#ros.emit('error', event);
    });
  }

  close() {
    this.#client.close();
  }

  send(message: { op: string }) {
    if (message.op === 'advertise') {
      this.#advertise(message as never);
    } else if (message.op === 'unadvertise') {
      this.#unadvertise(message as never);
    } else if (message.op === 'publish') {
      this.#publish(message as never);
    } else if (message.op === 'subscribe') {
      this.#subscribe(message as never);
    } else if (message.op === 'unsubscribe') {
      this.#unsubscribe(message as never);
    } else if (message.op === 'call_service') {
      this.#callService(message as never);
    } else {
      console.error('not implemented', message);
    }
  }

  #advertise(message: { topic: string; type: string }) {
    const publisherId = this.#client.advertise({
      topic: message.topic,
      encoding: this.#isRos2 ? 'cdr' : 'ros1',
      schemaName: message.type,
    });
    const unadvertise = () => {
      this.#client.unadvertise(publisherId);
    };
    const publish = new Promise<(msg: unknown) => void>((resolve) => {
      this.#getChannel(message.topic).then((channel) => {
        const writer = this.#getMessageWriter(channel);
        resolve((msg: unknown) => {
          this.#client.sendMessage(publisherId, writer.writeMessage(msg));
        });
      });
    });
    this.#unadvertiseByName.set(message.topic, unadvertise);
    this.#publishByName.set(message.topic, publish);
  }

  #unadvertise(message: { topic: string }) {
    const unadvertise = this.#unadvertiseByName.get(message.topic);
    if (unadvertise) {
      unadvertise();
    }
    this.#unadvertiseByName.delete(message.topic);
  }

  async #publish(message: { topic: string; msg: unknown }) {
    const publish = await this.#publishByName.get(message.topic);
    if (publish) {
      publish(message.msg);
    }
  }

  async #subscribe(message: { topic: string }) {
    const channel = await this.#getChannel(message.topic);
    const subscriptionId = this.#client.subscribe(channel.id);
    const listener = (event: MessageData) => {
      if (event.subscriptionId === subscriptionId) {
        const reader = this.#getMessageReader(channel);
        this.#ros.emit(message.topic, reader.readMessage(event.data));
      }
    };
    const unsubscribe = () => {
      this.#client.off('message', listener);
      this.#client.unsubscribe(subscriptionId);
    };
    this.#unsubscribeByName.set(message.topic, unsubscribe);
    this.#client.on('message', listener);
  }

  #unsubscribe(message: { topic: string }) {
    const unsubscribe = this.#unsubscribeByName.get(message.topic);
    if (unsubscribe) {
      unsubscribe();
    }
    this.#unsubscribeByName.delete(message.topic);
  }

  async #callService(message: {
    id: string;
    service: string;
    type: string;
    args: never;
  }) {
    if (message.type === 'rosapi/GetParam') {
      this.#getParam(message);
    } else if (message.type === 'rosapi/SetParam') {
      this.#setParam(message);
    } else if (message.type === 'rosapi/Topics') {
      this.#getTopics(message);
    } else if (message.type === 'rosapi/Services') {
      this.#getServices(message);
    } else if (message.type === 'rosapi/TopicType') {
      this.#getTopicType(message);
    } else if (message.type === 'rosapi/ServiceType') {
      this.#getServiceType(message);
    } else if (message.type.startsWith('rosapi/')) {
      console.error('not implemented', message);
    }

    const service = await this.#getService(message.service);
    const writer = this.#getMessageWriter(service);
    const reader = this.#getMessageReader(service);
    const callId = this.#callId++;

    const listener = (event: ServiceCallResponse) => {
      if (event.serviceId === service.id && event.callId === callId) {
        this.#client.off('serviceCallResponse', listener);
        this.#ros.emit(message.id, {
          values: reader.readMessage(event.data),
          result: true,
        });
      }
    };
    this.#client.on('serviceCallResponse', listener);

    const failureListener = (event: ServiceCallFailure) => {
      if (event.serviceId === service.id && event.callId === callId) {
        this.#client.off('serviceCallFailure', failureListener);
        this.#ros.emit(message.id, { values: event.message, result: false });
      }
    };
    this.#client.on('serviceCallFailure', failureListener);

    this.#client.sendServiceCallRequest({
      serviceId: service.id,
      callId,
      encoding: this.#isRos2 ? 'cdr' : 'ros1',
      data: new DataView(writer.writeMessage(message.args).buffer),
    });
  }

  #getParam(message: { id: string; args: { name: string } }) {
    const name = message.args.name.replace(':', '.');
    const listener = (event: ParameterValues) => {
      if (event.parameters[0]?.name === name && event.id === message.id) {
        this.#client.off('parameterValues', listener);
        this.#ros.emit(message.id, {
          values: { value: JSON.stringify(event.parameters[0].value) },
          result: true,
        });
      }
    };
    this.#client.on('parameterValues', listener);
    this.#client.getParameters([name], message.id);
  }

  #setParam(message: {
    id: string;
    args: { name: string; value: string };
  }) {
    const name = message.args.name.replace(':', '.');
    const listener = (event: ParameterValues) => {
      if (event.parameters[0]?.name === name && event.id === message.id) {
        this.#client.off('parameterValues', listener);
        this.#ros.emit(message.id, { result: true });
      }
    };
    this.#client.on('parameterValues', listener);
    this.#client.setParameters(
      [{ name, value: JSON.parse(message.args.value) }],
      message.id,
    );
  }

  #getTopics(message: { id: string }) {
    const topics = {
      topics: [...this.#channelsByName.keys()],
      types: [...this.#channelsByName.values()].map((x) => x.schemaName),
    };
    this.#ros.emit(message.id, { values: topics, result: true });
  }

  #getServices(message: { id: string }) {
    const listener = (event: ConnectionGraphUpdate) => {
      this.#client.off('connectionGraphUpdate', listener);
      this.#client.unsubscribeConnectionGraph();
      this.#ros.emit(message.id, {
        values: {
          services: event.advertisedServices.map((service) => service.name),
        },
        result: true,
      });
    };
    this.#client.on('connectionGraphUpdate', listener);
    this.#client.subscribeConnectionGraph();
  }

  #getTopicType(message: { id: string; args: { topic: string } }) {
    const topicType = this.#channelsByName.get(message.args.topic)?.schemaName;
    if (topicType) {
      this.#ros.emit(message.id, { values: { type: topicType }, result: true });
    } else {
      this.#ros.emit(message.id, { result: false });
    }
  }

  #getServiceType(message: { id: string; args: { service: string } }) {
    const serviceType = this.#servicesByName.get(message.args.service)?.type;
    if (serviceType) {
      this.#ros.emit(message.id, {
        values: { type: serviceType },
        result: true,
      });
    } else {
      this.#ros.emit(message.id, { result: false });
    }
  }

  async #getChannel(name: string) {
    return (
      this.#channelsByName.get(name) ??
      (await new Promise<Channel>((resolve) => {
        const listener = (channels: Channel[]) => {
          const channel = channels.find((channel) => channel.topic === name);
          if (channel) {
            this.#client.off('advertise', listener);
            resolve(channel);
          }
        };
        this.#client.on('advertise', listener);
      }))
    );
  }

  async #getService(name: string) {
    return (
      this.#servicesByName.get(name) ??
      (await new Promise<Service>((resolve) => {
        const listener = (services: Service[]) => {
          const service = services.find((service) => service.name === name);
          if (service) {
            this.#client.off('advertiseServices', listener);
            resolve(service);
          }
        };
        this.#client.on('advertiseServices', listener);
      }))
    );
  }

  #getMessageReader(channelOrService: Channel | Service) {
    const name =
      'schema' in channelOrService
        ? channelOrService.schemaName
        : channelOrService.type;
    return (
      this.#messageReaders.get(name) ??
      (() => {
        const schema =
          'schema' in channelOrService
            ? channelOrService.schema
            : (channelOrService.response?.schema ??
              channelOrService.responseSchema);
        const schemaEncoding =
          'schema' in channelOrService
            ? channelOrService.schemaEncoding
            : channelOrService.response?.schemaEncoding;
        if (typeof schema !== 'string') {
          console.log(channelOrService);
          throw new Error('schema not found');
        }
        const reader = this.#isRos2
          ? new Ros2MessageReader(
              schemaEncoding === 'ros2idl'
                ? parseRos2idl(schema)
                : parse(schema, { ros2: true }),
            )
          : new Ros1MessageReader(parse(schema, { ros2: false }));
        this.#messageReaders.set(name, reader);
        return reader;
      })()
    );
  }

  #getMessageWriter(channelOrService: Channel | Service) {
    const name =
      'schema' in channelOrService
        ? channelOrService.schemaName
        : channelOrService.type;
    return (
      this.#messageWriters.get(name) ??
      (() => {
        const schema =
          'schema' in channelOrService
            ? channelOrService.schema
            : (channelOrService.request?.schema ??
              channelOrService.requestSchema);
        const schemaEncoding =
          'schema' in channelOrService
            ? channelOrService.schemaEncoding
            : channelOrService.request?.schemaEncoding;
        if (typeof schema !== 'string') {
          throw new Error('schema not found');
        }
        const writer = this.#isRos2
          ? new Ros2MessageWriter(
              schemaEncoding === 'ros2idl'
                ? parseRos2idl(schema)
                : parse(schema, { ros2: true }),
            )
          : new Ros1MessageWriter(parse(schema, { ros2: false }));
        this.#messageWriters.set(name, writer);
        return writer;
      })()
    );
  }
}

export class FoxgloveRos extends Ros {
  socket: FoxgloveSocket | null = null;

  constructor(options: {
    url?: string;
  }) {
    super({
      ...options,
      transportOptions: {
        encoder: (
          message: unknown,
          sendEncodedMessage: (message: unknown) => void,
        ) => sendEncodedMessage(message),
      } as never,
    });
  }

  connect(url: string) {
    this.socket = new FoxgloveSocket(url, this);
  }
}
