var _ = require('lodash');
var path = require('path');
var Promise = require('bluebird');
var validateOpts = require('validate-options');
var zookeeper = require('node-zookeeper-client');

function createRecursive(createFunction, node_path, data) {
    if (node_path == '/') {
        return Promise.resolve();
    } else {
        return createRecursive(createFunction, path.dirname(node_path))
            .then(function() {
                if (data) {
                    return createFunction(node_path, data);
                } else {
                    return createFunction(node_path);
                }
            });
    }
}

function ZKOffsetDirectory(options) {
    validateOpts.hasAll(options, 'zookeeper', 'rootpath', 'topic');
    var zkOptions = {};
    if (options.zkOptions) {
        zkOptions = options.zkOptions;
    }
    this.zk = zookeeper.createClient(options.zookeeper);
    this.zk.connect();
    this.topic = options.topic;
    this.rootpath = options.rootpath;

    // Promise for current commit action
    this._current_commit = null;

    // Offsets & promise for next commit after _current_commit completes
    this._pending_offsets = {};
    this._next_commit = null;
}

ZKOffsetDirectory.prototype._partition_path = function(partition) {
    return path.join(this.rootpath, this.topic, partition.toString() + '.offset');
};

ZKOffsetDirectory.prototype._read_one = function(partition) {
    var exists = Promise.promisify(this.zk.exists).bind(this.zk);
    var getData = Promise.promisify(this.zk.getData).bind(this.zk);
    var path = this._partition_path(partition);
    return exists(path)
        .then(function(exists) {
            if (exists) {
                return getData(path)
                    .then(function(buffers) {
                        return +buffers[0].toString();
                    });
            } else {
                return -1;
            }
        });
};

// Map an array of partition ids to their last committed offset,
// or -1 if none found.
ZKOffsetDirectory.prototype.read = function(partitions) {
    return Promise.map(partitions, this._read_one.bind(this));
};

ZKOffsetDirectory.prototype._commit_one = function(partition, offset) {
    var buf = new Buffer(offset.toString());
    var setData = Promise.promisify(this.zk.setData).bind(this.zk);
    var createNode = Promise.promisify(this.zk.create).bind(this.zk);
    var exists = Promise.promisify(this.zk.exists).bind(this.zk);
    var full_path = this._partition_path(partition);
    return exists(full_path)
        .then(function(exists) {
            if (exists) return setData(full_path, buf);
            else return createRecursive(createNode, full_path, buf);
        });
}

// Atomically update the commit offset node for this partition.
ZKOffsetDirectory.prototype._commit = function(poffsets) {
    var self = this;
    return Promise.map(_.keys(poffsets), function(partition) {
        var offset = poffsets[partition];
        return self._commit_one(partition, offset);
    });
};

// Update commit offset files for partitions.
// partition_offsets is an object of partition id -> offset.
// Can wait on pending commits to complete by calling with no parameter.
ZKOffsetDirectory.prototype.commit = function(partition_offsets) {
    var self = this;
    partition_offsets = partition_offsets || {};

    function do_commit(poffsets) {
        self._current_commit = self._commit(poffsets)
        .finally(function() {
            self._current_commit = null;
        });
        return self._current_commit;
    }

    if (!self._current_commit) {
        return do_commit(_.clone(partition_offsets));
    }

    // If there's a commit in progress, overwrite any pending offsets
    // with this call, and setup promise to fulfill after _current_commit.
    _.extend(self._pending_offsets, partition_offsets);
    if (!self._next_commit) {
        self._next_commit = self._current_commit.finally(function() {
            var poffsets = self._pending_offsets;
            self._pending_offsets = {};
            self._next_commit = null;
            return do_commit(poffsets);
        });
    }
    return self._next_commit;
};

module.exports = ZKOffsetDirectory;
