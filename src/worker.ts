import './global';

import ROSLIB from 'roslib';
import { FoxgloveRos } from './FoxgloveRos';

const ros = new FoxgloveRos({});

// If there is an error on the backend, an 'error' emit will be emitted.
ros.on('error', (error) => {
  console.log(error);
});

// Find out exactly when we made a connection.
ros.on('connection', () => {
  console.log('Connection made!');
});

ros.on('close', () => {
  console.log('Connection closed.');
});

// Create a connection to the rosbridge WebSocket server.
ros.connect('ws://localhost:8765');

// Publishing a Topic
// ------------------

// First, we create a Topic object with details of the topic's name and message type.
const cmdVel = new ROSLIB.Topic({
  ros: ros,
  name: '/cmd_vel',
  messageType: 'geometry_msgs/Twist',
});

// Then we create the payload to be published. The object we pass in to ros.Message matches the
// fields defined in the geometry_msgs/Twist.msg definition.
const twist = {
  linear: {
    x: 0.1,
    y: 0.2,
    z: 0.3,
  },
  angular: {
    x: -0.1,
    y: -0.2,
    z: -0.3,
  },
};

// And finally, publish.
cmdVel.publish(twist);

// Subscribing to a Topic
// ----------------------

// Like when publishing a topic, we first create a Topic object with details of the topic's name
// and message type. Note that we can call publish or subscribe on the same topic object.
const listener = new ROSLIB.Topic<{ data: string }>({
  ros: ros,
  name: '/listener',
  messageType: 'std_msgs/String',
});

// Then we add a callback to be called every time a message is published on this topic.
listener.subscribe((message) => {
  console.log(`Received message on ${listener.name}: ${message.data}`);

  // If desired, we can unsubscribe from the topic as well.
  listener.unsubscribe();
});

// Calling a service
// -----------------

// First, we create a Service client with details of the service's name and service type.
const addTwoIntsClient = new ROSLIB.Service({
  ros: ros,
  name: '/add_two_ints',
  serviceType: 'example_interfaces/AddTwoInts',
});

// Then we create a Service Request. The object we pass in to ROSLIB.ServiceRequest matches the
// fields defined in the rospy_tutorials AddTwoInts.srv file.
const request = {
  a: 1,
  b: 2,
};

// Finally, we call the /add_two_ints service and get back the results in the callback. The result
// is a ROSLIB.ServiceResponse object.
addTwoIntsClient.callService(request, (result) => {
  console.log(
    `Result for service call on ${addTwoIntsClient.name}: ${result.sum}`,
  );
});

// Advertising a Service
// ---------------------

// The Service object does double duty for both calling and advertising services
const setBoolServer = new ROSLIB.Service({
  ros: ros,
  name: '/set_bool',
  serviceType: 'std_srvs/SetBool',
});

// Use the advertise() method to indicate that we want to provide this service
setBoolServer.advertise((request, response) => {
  console.log(
    `Received service request on ${setBoolServer.name}: ${request.data}`,
  );
  response.success = true;
  response.message = 'Set successfully';
  return true;
});

// Getting a param value
// ---------------------

// In ROS 2, params are set in the format 'node_name:param_name'
const favoriteColor = new ROSLIB.Param({
  ros: ros,
  name: '/add_two_ints_server:use_sim_time',
});

favoriteColor.get((value) => {
  console.log(`The value of use_sim_time before setting is ${value}`);
});
favoriteColor.set(true, () => {});
favoriteColor.get((value) => {
  console.log(`The value of use_sim_time after setting is ${value}`);
});
