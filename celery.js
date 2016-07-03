var url = require('url'),
    util = require('util'),
    amqp = require('amqp'),
    redis = require('redis'),
    rethinkdb = require('rethinkdb'),
    events = require('events'),
    uuid = require('node-uuid'),
    wildcard = require('wildcard');

var createMessage = require('./protocol').createMessage;


debug = process.env.NODE_CELERY_DEBUG === '1' ? util.debug : function() {};

function Configuration(options) {
    var self = this;

    for (var o in options) {
        if (options.hasOwnProperty(o)) {
            self[o.replace(/^CELERY_/, '')] = options[o];
        }
    }

    self.BROKER_URL = self.BROKER_URL || 'amqp://';
    self.BROKER_OPTIONS = self.BROKER_OPTIONS || { url: self.BROKER_URL, heartbeat: 580 };
    self.DEFAULT_QUEUE = self.DEFAULT_QUEUE || 'celery';
    self.DEFAULT_EXCHANGE = self.DEFAULT_EXCHANGE || '';
    self.DEFAULT_EXCHANGE_TYPE = self.DEFAULT_EXCHANGE_TYPE || 'direct';
    self.DEFAULT_ROUTING_KEY = self.DEFAULT_ROUTING_KEY || 'celery';
    self.RESULT_EXCHANGE = self.RESULT_EXCHANGE || 'celeryresults';
    self.TASK_RESULT_EXPIRES = self.TASK_RESULT_EXPIRES * 1000 || 86400000; // Default 1 day
    self.TASK_RESULT_DURABLE = undefined !== self.TASK_RESULT_DURABLE ? self.TASK_RESULT_DURABLE : true; // Set Durable true by default (Celery 3.1.7)
    self.ROUTES = self.ROUTES || {};

    self.broker_type = url.parse(self.BROKER_URL).protocol.slice(0, -1);
    debug('Broker type: ' + self.broker_type);

    if (self.RESULT_BACKEND && self.RESULT_BACKEND.toLowerCase() === 'amqp') {
        self.backend_type = 'amqp';
    } else {
        var purl = url.parse(self.RESULT_BACKEND);
        if (self.RESULT_BACKEND && purl.protocol === 'redis:') {
            self.backend_type = 'redis';
        } else if (self.RESULT_BACKEND && purl.protocol === 'rethinkdb:') {
            self.backend_type = 'rethinkdb';
            debug('Using rethinkdb...');
            var auth_parsed = purl.auth && purl.auth.match(/([^:]+)(:[^:]+))?/);
            self.BACKEND_CONNECT_OPTIONS =
                self.BACKEND_CONNECT_OPTIONS || {
                    host: purl.hostname,
                    port: purl.port && parseInt(purl.port),
                    db: purl.pathname && purl.pathname.replace(/\/+/g, '')
                }
            if(auth_parsed){
                self.BACKEND_CONNECT_OPTIONS.user =
                    self.BACKEND_CONNECT_OPTIONS.user ||
                    (auth_parsed && auth_parsed[1]);
                self.BACKEND_CONNECT_OPTIONS.password =
                    self.BACKEND_CONNECT_OPTIONS.password ||
                    (auth_parsed && auth_parsed[3]);
            }
        }
    }
}

function RedisBroker(broker_url) {
    var self = this;
    var purl = url.parse(broker_url);
    var database;
    if (purl.pathname) {
      database = purl.pathname.slice(1);
    }

    self.redis = redis.createClient(purl.port || 6379,
                                    purl.hostname || 'localhost');
    if (database) {
        self.redis.select(database);
    }

    if (purl.auth) {
        debug('Authenticating broker...');
        self.redis.auth(purl.auth.split(':')[1]);
        debug('Broker authenticated...');
    }

    self.end = function() {
      self.redis.end();
    };
    
    self.disconnect = function() {
        self.redis.end();
    };

    self.redis.on('connect', function() {
        self.emit('ready');
    });

    self.redis.on('error', function(err) {
        self.emit('error', err);
    });

    self.redis.on('end', function() {
        self.emit('end');
    });

    self.publish = function(queue, message, options, callback, id) {
        var payload = {
            body: new Buffer(message).toString('base64'),
            headers: {},
            'content-type': options.contentType,
            'content-encoding': options.contentEncoding,
            properties: {
                body_encoding: 'base64',
                correlation_id: id,
                delivery_info: {
                    exchange: queue,
                    priority: 0,
                    routing_key: queue
                },
                delivery_mode: 2, // No idea what this means
                delivery_tag: uuid.v4(),
                reply_to: uuid.v4()
            }
        };
        self.redis.lpush(queue, JSON.stringify(payload));
    };

    return self;
}
util.inherits(RedisBroker, events.EventEmitter);

function RethinkdbBackend(options){
    var self = this;
    self.conn = null;
    self.options = options;
    self.results = {};
    self.is_connected = false;
    self.quit = function(){
        debug('Closing rethinkdb connection...');
        self.conn.close();
        self.is_connected = false;
    };
    rethinkdb.connect(self.options, function(err, conn) {
        if(err){
            self.emit('error', err);
            return;
        }
        self.conn = conn;
        self.is_connected = true;
        self.emit('connect');
        rethinkdb.table('celery_taskmeta').changes().run(conn, function(err, cursor){
            if(err){
                self.emit('error', err);
                return;
            }
            cursor.each(function(err, row){
                if(err){
                    if(err.name === 'ReqlRuntimeError' &&
                            err.msg ==='Connection is closed.' &&
                            !self.is_connected) {
                        debug('Closing rethinkdb cursor...');
                        // cursor.close();
                    } else {
                        self.emit('error', err);
                    }
                    return;
                }
                if( row.new_val && (!row.old_val) ) {
                    var result = self.results[row.new_val.id];
                    if(result){
                        result.full_result = row.new_val;
                        result.result = row.new_val.result;
                        result.emit('ready', result.result);
                        delete self.results[row.new_val.id];
                    }
                }
            });
        });
    });
    return self;
}
util.inherits(RethinkdbBackend, events.EventEmitter);


function Client(conf) {
    var self = this;

    self.conf = new Configuration(conf);

    self.ready = false;
    self.broker_connected = false;
    self.backend_connected = false;

    debug('Connecting to broker...');
    if (self.conf.broker_type === 'amqp') {
      self.broker = amqp.createConnection(
        self.conf.BROKER_OPTIONS, {
          defaultExchangeName: self.conf.DEFAULT_EXCHANGE
      });
    } else if (self.conf.broker_type === 'redis') {
      self.broker = new RedisBroker(self.conf.BROKER_URL);
    }

    if (self.conf.backend_type === self.conf.broker_type) {

        if (self.conf.backend_type === 'redis') {
          self.backend = self.broker.redis;
        } else {
          self.backend = self.broker;
        }
        self.backend_connected = true;
    } else if (self.conf.backend_type === 'amqp') {
        self.backend = amqp.createConnection({
            url: self.conf.BROKER_URL,
            heartbeat: 580
        }, {
            defaultExchangeName: self.conf.DEFAULT_EXCHANGE
        });
    } else if (self.conf.backend_type === 'redis' || self.conf.backend_type === 'rethinkdb') {
        if (self.conf.backend_type === 'redis') {
            var purl = url.parse(self.conf.RESULT_BACKEND),
                database = purl.pathname.slice(1);
            debug('Connecting to backend...');
            self.backend = redis.createClient(purl.port, purl.hostname);
            if (database) {
                self.backend.select(database);
            }

            if (purl.auth) {
                debug('Authenticating backend...');
                self.backend.auth(purl.auth.split(':')[1]);
                debug('Backend authenticated...');
            }
        } else if( self.conf.backend_type === 'rethinkdb' ) {
            self.backend = new RethinkdbBackend(self.conf.BACKEND_CONNECT_OPTIONS);
        }
        self.backend.on('connect', function() {
            debug('Backend connected...');
            self.backend_connected = true;
            if (self.broker_connected) {
                self.ready = true;
                debug('Emiting connect event...');
                self.emit('connect', self);
            }
        });

        self.backend.on('error', function(err) {
            self.emit('error', err);
        });
    } else {
        self.backend_connected = true;
    }

    self.broker.on('ready', function() {
        debug('Broker connected...');
        self.broker_connected = true;
        if (self.backend_connected) {
            self.ready = true;
            debug('Emiting connect event...');
            self.emit('connect', self);
        }
    });

    self.broker.on('error', function(err) {
        self.emit('error', err);
    });

    self.broker.on('end', function() {
        self.emit('end');
    });
}

util.inherits(Client, events.EventEmitter);

Client.prototype.createTask = function(name, options, exchange) {
    return new Task(this, name, options, exchange);
};

Client.prototype.end = function() {
    this.broker.disconnect();
    if (this.backend && this.broker !== this.backend) {
        this.backend.quit();
    }
};

Client.prototype.call = function(name /*[args], [kwargs], [options], [callback]*/ ) {
    var args, kwargs, options, callback;
    for (var i = arguments.length - 1; i > 0; i--) {
        if (typeof arguments[i] === 'function') {
            callback = arguments[i];
        } else if (Array.isArray(arguments[i])) {
            args = arguments[i];
        } else if (typeof arguments[i] === 'object') {
            if (options) {
                kwargs = arguments[i];
            } else {
                options = arguments[i];
            }
        }
    }

    var task = this.createTask(name),
        result = task.call(args, kwargs, options);

    if (callback && result) {
        debug('Subscribing to result...');
        result.on('ready', callback);
    }
    return result;
};

function Task(client, name, options, exchange) {
    var self = this;

    self.client = client;
    self.name = name;
    self.options = options || {};
    var route;
    // get all first route pattern that match given route name
    for(var pattern in self.client.conf.ROUTES) {
        if (self.client.conf.ROUTES.hasOwnProperty(pattern)) {
            if( wildcard(pattern, name) ){
                route = self.client.conf.ROUTES[pattern];
                break;
            }
        }
    }
    var queue = route && route.queue;

    self.publish = function (args, kwargs, options, callback) {
        var id = options.id || uuid.v4();

        queue = options.queue || self.options.queue || queue || self.client.conf.DEFAULT_QUEUE;
        var msg = createMessage(self.name, args, kwargs, options, id);
        var pubOptions = {
            'contentType': 'application/json',
            'contentEncoding': 'utf-8'
        };

        if (exchange) {
            exchange.publish(queue, msg, pubOptions, callback);
        } else {
            self.client.broker.publish(queue, msg, pubOptions, callback);
        }

        return new Result(id, self.client);
    };
}

Task.prototype.call = function(args, kwargs, options, callback) {
    var self = this;

    args = args || [];
    kwargs = kwargs || {};
    options = options || self.options || {};

    if (!self.client.ready) {
        self.client.emit('error', 'Client is not ready');
    }
    else {
        return self.publish(args, kwargs, options, callback);
    }
};

function Result(taskid, client) {
    var self = this;

    events.EventEmitter.call(self);
    self.taskid = taskid;
    self.client = client;
    self.result = null;

    if (self.client.conf.backend_type === 'amqp') {
        debug('Subscribing to result queue...');
        self.client.backend.queue(
            self.taskid.replace(/-/g, ''), {
                "arguments": {
                    'x-expires': self.client.conf.TASK_RESULT_EXPIRES
                },
                'durable': self.client.conf.TASK_RESULT_DURABLE,
                'closeChannelOnUnsubscribe': true
            },

            function (q) {
                q.bind(self.client.conf.RESULT_EXCHANGE, '#');
                var ctag;
                q.subscribe(function (message) {
                    if (message.contentType === 'application/x-python-serialize') {
                        console.error('Celery should be configured with json serializer');
                        process.exit(1);
                    }
                    self.result = message;
                    q.unsubscribe(ctag);
                    debug('Emiting ready event...');
                    self.emit('ready', message);
                    debug('Emiting task status event...');
                    self.emit(message.status.toLowerCase(), message);
                }).addCallback(function(ok) { ctag = ok.consumerTag; });
            });
    }else if(self.client.conf.backend_type === 'rethinkdb') {
        self.client.backend.results[self.taskid] = self;
    }
}

util.inherits(Result, events.EventEmitter);

Result.prototype.get = function(callback) {
    var self = this;
    if (callback && self.result === null) {
        self.client.backend.get('celery-task-meta-' + self.taskid, function(err, reply) {
            self.result = JSON.parse(reply);
            callback(self.result);
        });
    } else {
        if (callback) {
            callback(self.result);
        }
        return self.result;
    }
};

exports.createClient = function(config, callback) {
    return new Client(config, callback);
};
