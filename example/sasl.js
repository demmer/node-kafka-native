var kafka_native = require('../index');
var broker = process.env.NODE_KAFKA_NATIVE_BROKER || 'localhost:9093';
var topic = 'example';

var driver_options = {
    'security.protocol': 'sasl_ssl',
    //Ubuntu: /etc/ssl/certs
    //Red Hat: /etc/pki/tls/cert.pem
    //Mac OS X: select system root certificates from Keychain Access and export as .pem on the filesystem
    'ssl.ca.location': '/etc/ssl/certs',
    'sasl.mechanisms': 'PLAIN',
    'sasl.username': process.env.SASL_USERNAME,
    'sasl.password': process.env.SASL_PASSWORD
}

var producer = new kafka_native.Producer({
    broker: broker,
    driver_options: driver_options
});
var consumer = new kafka_native.Consumer({
    broker: broker,
    topic: topic,
    offset_directory: './kafka-offsets',
    receive_callback: function(data) {
        data.messages.forEach(function(m) {
            console.log('message: ', m.topic, m.partition, m.offset, m.payload);
        })
        return Promise.resolve();
    },
    driver_options: driver_options
});

producer.partition_count(topic)
.then(function(npartitions) {
    var partition = 0;
    setInterval(function() {
        producer.send(topic, partition++ % npartitions, ['hello']);
    }, 1000);

    return consumer.start();
});

