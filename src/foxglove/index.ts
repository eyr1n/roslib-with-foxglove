import ROSLIB from 'roslib';
import { FoxgloveSocket } from './FoxgloveSocket';

export function createRos(options: { url?: string }) {
  const ros = new ROSLIB.Ros({});

  // override ros.connect()
  Object.assign(ros, {
    connect: (url: string) => {
      Object.assign(ros, {
        socket: new FoxgloveSocket(url, ros),
        transportOptions: {
          encoder: (
            message: unknown,
            sendEncodedMessage: (message: unknown) => void,
          ) => sendEncodedMessage(message),
        },
      });
    },
  });

  if (options.url) {
    ros.connect(options.url);
  }
  return ros;
}
