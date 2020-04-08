// Copyright IBM Corp. 2013,2020. All Rights Reserved.
// Node module: loopback-connector-postgresql
// This file is licensed under the Artistic License 2.0.
// License text available at https://opensource.org/licenses/Artistic-2.0

/*!
 * PostgreSQL connector for LoopBack
 */
'use strict';
const SG = require('strong-globalize');
const g = SG();
const postgresql = require('pg');
const SqlConnector = require('loopback-connector').SqlConnector;
const ParameterizedSQL = SqlConnector.ParameterizedSQL;
const util = require('util');
const debug = require('debug')('loopback:connector:postgresql');
const debugData = require('debug')('loopback:connector:postgresql:data');
const debugSort = require('debug')('loopback:connector:postgresql:order');
const Promise = require('bluebird');

/**
 *
 * Initialize the PostgreSQL connector against the given data source
 *
 * @param {DataSource} dataSource The loopback-datasource-juggler dataSource
 * @callback {Function} [callback] The callback function
 * @param {String|Error} err The error string or object
 * @header PostgreSQL.initialize(dataSource, [callback])
 */
exports.initialize = function initializeDataSource(dataSource, callback) {
  if (!postgresql) {
    return;
  }

  const dbSettings = dataSource.settings || {};
  dbSettings.host = dbSettings.host || dbSettings.hostname || 'localhost';
  dbSettings.user = dbSettings.user || dbSettings.username;

  dataSource.connector = new PostgreSQL(postgresql, dbSettings);
  dataSource.connector.dataSource = dataSource;

  if (callback) {
    if (dbSettings.lazyConnect) {
      process.nextTick(callback);
    } else {
      dataSource.connecting = true;
      dataSource.connector.connect(callback);
    }
  }
};

/**
 * PostgreSQL connector constructor
 *
 * @param {PostgreSQL} postgresql PostgreSQL node.js binding
 * @options {Object} settings An object for the data source settings.
 * See [node-postgres documentation](https://github.com/brianc/node-postgres/wiki/Client#parameters).
 * @property {String} url URL to the database, such as 'postgres://test:mypassword@localhost:5432/devdb'.
 * Other parameters can be defined as query string of the url
 * @property {String} hostname The host name or ip address of the PostgreSQL DB server
 * @property {Number} port The port number of the PostgreSQL DB Server
 * @property {String} user The user name
 * @property {String} password The password
 * @property {String} database The database name
 * @property {Boolean} ssl Whether to try SSL/TLS to connect to server
 *
 * @constructor
 */
function PostgreSQL(postgresql, settings) {
  // this.name = 'postgresql';
  // this._models = {};
  // this.settings = settings;
  this.constructor.super_.call(this, 'postgresql', settings);
  this.clientConfig = settings;
  if (settings.url) {
    // pg-pool doesn't handle string config correctly
    this.clientConfig.connectionString = settings.url;
  }
  this.clientConfig.Promise = Promise;
  this.pg = new postgresql.Pool(this.clientConfig);

  this.settings = settings;
  debug('Settings %j', settings);
}

// Inherit from loopback-datasource-juggler BaseSQL
util.inherits(PostgreSQL, SqlConnector);

PostgreSQL.prototype.getDefaultSchemaName = function () {
  return 'public';
};

/**
 * Connect to PostgreSQL
 * @callback {Function} [callback] The callback after the connection is established
 */
PostgreSQL.prototype.connect = function (callback) {
  const self = this;
  self.pg.connect(function (err, client, releaseCb) {
    self.client = client;
    process.nextTick(releaseCb);
    callback && callback(err, client);
  });
};

/**
 * Execute the sql statement
 *
 * @param {String} sql The SQL statement
 * @param {String[]} params The parameter values for the SQL statement
 * @param {Object} [options] Options object
 * @callback {Function} [callback] The callback after the SQL statement is executed
 * @param {String|Error} err The error string or object
 * @param {Object[]} data The result from the SQL
 */
PostgreSQL.prototype.executeSQL = function (sql, params, options, callback) {
  const self = this;

  if (params && params.length > 0) {
    debug('SQL: %s\nParameters: %j', sql, params);
  } else {
    debug('SQL: %s', sql);
  }

  function executeWithConnection(connection, releaseCb) {
    connection.query(sql, params, function (err, data) {
      // if(err) console.error(err);
      if (err) debug(err);
      if (data) debugData('%j', data);
      // Release the connection back to the pool.
      if (releaseCb) releaseCb(err);
      let result = null;
      if (data) {
        switch (data.command) {
          case 'DELETE':
          case 'UPDATE':
            result = {affectedRows: data.rowCount, count: data.rowCount};

            if (data.rows) result.rows = data.rows;

            break;
          default:
            result = data.rows;
        }
      }
      callback(err ? err : null, result);
    });
  }

  const transaction = options.transaction;
  if (transaction && transaction.connector === this) {
    if (!transaction.connection) {
      return process.nextTick(function () {
        callback(new Error(g.f('Connection does not exist')));
      });
    }
    if (transaction.txId !== transaction.connection.txId) {
      return process.nextTick(function () {
        callback(new Error(g.f('Transaction is not active')));
      });
    }
    debug('Execute SQL within a transaction');
    // Do not release the connection
    executeWithConnection(transaction.connection, null);
  } else {
    self.pg.connect(function (err, connection, releaseCb) {
      if (err) return callback(err);
      executeWithConnection(connection, releaseCb);
    });
  }
};

PostgreSQL.prototype.buildInsertReturning = function (model, data, options) {
  const idColumnNames = [];
  const idNames = this.idNames(model);
  for (let i = 0, n = idNames.length; i < n; i++) {
    idColumnNames.push(this.columnEscaped(model, idNames[i]));
  }
  return 'RETURNING ' + idColumnNames.join(',');
};

/**
 * Check if id types have a numeric type
 * @param {String} model name
 * @returns {Boolean}
 */
PostgreSQL.prototype.hasOnlyNumericIds = function (model) {
  const cols = this.getModelDefinition(model).properties;
  const idNames = this.idNames(model);
  const numericIds = idNames.filter(function (idName) {
    return cols[idName].type === Number;
  });

  return numericIds.length == idNames.length;
};

/**
 * Get default find sort policy
 * @param model
 */
PostgreSQL.prototype.getDefaultIdSortPolicy = function (model) {
  const modelClass = this._models[model];

  if (modelClass.settings.hasOwnProperty('defaultIdSort')) {
    return modelClass.settings.defaultIdSort;
  }

  if (this.settings.hasOwnProperty('defaultIdSort')) {
    return this.settings.defaultIdSort;
  }

  return null;
};

/**
 * Build a SQL SELECT statement
 * @param {String} model Model name
 * @param {Object} filter Filter object
 * @param {Object} options Options object
 * @returns {ParameterizedSQL} Statement object {sql: ..., params: ...}
 */
PostgreSQL.prototype.buildSelect = function (model, filter) {
  let sortById;

  const sortPolicy = this.getDefaultIdSortPolicy(model);

  switch (sortPolicy) {
    case 'numericIdOnly':
      sortById = this.hasOnlyNumericIds(model);
      break;
    case false:
      sortById = false;
      break;
    default:
      sortById = true;
      break;
  }

  debugSort(model, 'sort policy:', sortPolicy, sortById);

  if (sortById && !filter.order) {
    const idNames = this.idNames(model);
    if (idNames && idNames.length) {
      filter.order = idNames;
    }
  }

  let selectStmt = new ParameterizedSQL(
    'SELECT ' + this.buildColumnNames(model, filter) + ' FROM ' + this.tableEscaped(model),
  );

  if (filter) {
    if (filter.where) {
      const whereStmt = this.buildWhere(model, filter.where);
      selectStmt.merge(whereStmt);
    }

    if (filter.order) {
      selectStmt.merge(this.buildOrderBy(model, filter.order));
    }

    if (filter.limit || filter.skip || filter.offset) {
      selectStmt = this.applyPagination(model, selectStmt, filter);
    }
  }
  return this.parameterize(selectStmt);
};

PostgreSQL.prototype.buildInsertDefaultValues = function (model, data, options) {
  return 'DEFAULT VALUES';
};

// FIXME: [rfeng] The native implementation of upsert only works with
// postgresql 9.1 or later as it requres writable CTE
// See https://github.com/strongloop/loopback-connector-postgresql/issues/27
/**
 * Update if the model instance exists with the same id or create a new instance
 *
 * @param {String} model The model name
 * @param {Object} data The model instance data
 * @callback {Function} [callback] The callback function
 * @param {String|Error} err The error string or object
 * @param {Object} The updated model instance
 */
/*
 PostgreSQL.prototype.updateOrCreate = function (model, data, callback) {
 var self = this;
 data = self.mapToDB(model, data);
 var props = self._categorizeProperties(model, data);
 var idColumns = props.ids.map(function(key) {
 return self.columnEscaped(model, key); }
 );
 var nonIdsInData = props.nonIdsInData;
 var query = [];
 query.push('WITH update_outcome AS (UPDATE ', self.tableEscaped(model), ' SET ');
 query.push(self.toFields(model, data, false));
 query.push(' WHERE ');
 query.push(idColumns.map(function (key, i) {
 return ((i > 0) ? ' AND ' : ' ') + key + '=$' + (nonIdsInData.length + i + 1);
 }).join(','));
 query.push(' RETURNING ', idColumns.join(','), ')');
 query.push(', insert_outcome AS (INSERT INTO ', self.tableEscaped(model), ' ');
 query.push(self.toFields(model, data, true));
 query.push(' WHERE NOT EXISTS (SELECT * FROM update_outcome) RETURNING ', idColumns.join(','), ')');
 query.push(' SELECT * FROM update_outcome UNION ALL SELECT * FROM insert_outcome');
 var queryParams = [];
 nonIdsInData.forEach(function(key) {
 queryParams.push(data[key]);
 });
 props.ids.forEach(function(key) {
 queryParams.push(data[key] || null);
 });
 var idColName = self.idColumn(model);
 self.query(query.join(''), queryParams, function(err, info) {
 if (err) {
 return callback(err);
 }
 var idValue = null;
 if (info && info[0]) {
 idValue = info[0][idColName];
 }
 callback(err, idValue);
 });
 };
 */

PostgreSQL.prototype.fromColumnValue = function (prop, val) {
  if (val == null) {
    return val;
  }
  const type = prop.type && prop.type.name;
  if (prop && type === 'Boolean') {
    if (typeof val === 'boolean') {
      return val;
    } else {
      return val === 'Y' || val === 'y' || val === 'T' || val === 't' || val === '1';
    }
  } else if ((prop && type === 'GeoPoint') || type === 'Point') {
    if (typeof val === 'string') {
      // The point format is (x,y)
      const point = val.split(/[\(\)\s,]+/).filter(Boolean);
      return {
        lat: +point[0],
        lng: +point[1],
      };
    } else if (typeof val === 'object' && val !== null) {
      // Now pg driver converts point to {x: lng, y: lat}
      return {
        lng: val.x,
        lat: val.y,
      };
    } else {
      return val;
    }
  } else {
    return val;
  }
};

/*!
 * Convert to the Database name
 * @param {String} name The name
 * @returns {String} The converted name
 */
PostgreSQL.prototype.dbName = function (name) {
  if (!name) {
    return name;
  }
  // PostgreSQL default to lowercase names
  return name.toLowerCase();
};

PostgreSQL.prototype.dbNameWithPrefix = function (name, prefix) {
  if (!name) {
    return name;
  }

  prefix = prefix || "";
  // PostgreSQL default to lowercase names
  return (prefix + name).toLowerCase();
};

function escapeIdentifier(str) {
  let escaped = '"';
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '"') {
      escaped += c + c;
    } else {
      escaped += c;
    }
  }
  escaped += '"';
  return escaped;
}

function escapeLiteral(str) {
  let hasBackslash = false;
  let escaped = "'";
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === "'") {
      escaped += c + c;
    } else if (c === '\\') {
      escaped += c + c;
      hasBackslash = true;
    } else {
      escaped += c;
    }
  }
  escaped += "'";
  if (hasBackslash === true) {
    escaped = ' E' + escaped;
  }
  return escaped;
}

/*
 * Check if a value is attempting to use nested json keys
 * @param {String} property The property being queried from where clause
 * @returns {Boolean} True of the property contains dots for nested json
 */
function isNested(property) {
  return property.split('.').length > 1;
}

/*
 * Overwrite the loopback-connector column escape
 * to allow querying nested json keys
 * @param {String} model The model name
 * @param {String} property The property name
 * @returns {String} The escaped column name, or column with nested keys for deep json columns
 */
PostgreSQL.prototype.columnEscaped = function (model, property) {
  if (isNested(property)) {
    // Convert column to PostgreSQL json style query: "model"->>'val'
    const self = this;
    return property
      .split('.')
      .map(function (val, idx) {
        return idx === 0 ? self.columnEscaped(model, val) : escapeLiteral(val);
      })
      .reduce(function (prev, next, idx, arr) {
        return idx == 0 ? next : idx < arr.length - 1 ? prev + '->' + next : prev + '->>' + next;
      });
  } else {
    return this.escapeName(this.column(model, property));
  }
};

/*!
 * Escape the name for PostgreSQL DB
 * @param {String} name The name
 * @returns {String} The escaped name
 */
PostgreSQL.prototype.escapeName = function (name) {
  if (!name) {
    return name;
  }
  return escapeIdentifier(name);
};

PostgreSQL.prototype.escapeValue = function (value) {
  if (typeof value === 'string') {
    return escapeLiteral(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  // Can't send functions, objects, arrays
  if (typeof value === 'object' || typeof value === 'function') {
    return null;
  }
  return value;
};

PostgreSQL.prototype.tableEscaped = function (model) {
  const schema = this.schema(model) || 'public';
  return this.escapeName(schema) + '.' + this.escapeName(this.table(model));
};

function buildLimit(limit, offset) {
  const clause = [];
  if (isNaN(limit)) {
    limit = 0;
  }
  if (isNaN(offset)) {
    offset = 0;
  }
  if (!limit && !offset) {
    return '';
  }
  if (limit) {
    clause.push('LIMIT ' + limit);
  }
  if (offset) {
    clause.push('OFFSET ' + offset);
  }
  return clause.join(' ');
}

PostgreSQL.prototype.applyPagination = function (model, stmt, filter) {
  const limitClause = buildLimit(filter.limit, filter.offset || filter.skip);
  return stmt.merge(limitClause);
};

PostgreSQL.prototype.buildExpression = function (columnName, operator, operatorValue, propertyDefinition) {
  switch (operator) {
    case 'like':
      return new ParameterizedSQL(columnName + "::TEXT LIKE ? ESCAPE E'\\\\'", [operatorValue]);
    case 'ilike':
      return new ParameterizedSQL(columnName + "::TEXT ILIKE ? ESCAPE E'\\\\'", [operatorValue]);
    case 'nlike':
      return new ParameterizedSQL(columnName + "::TEXT NOT LIKE ? ESCAPE E'\\\\'", [operatorValue]);
    case 'nilike':
      return new ParameterizedSQL(columnName + "::TEXT NOT ILIKE ? ESCAPE E'\\\\'", [operatorValue]);
    case 'regexp':
      if (operatorValue.global) g.warn('{{PostgreSQL}} regex syntax does not respect the {{`g`}} flag');

      if (operatorValue.multiline) g.warn('{{PostgreSQL}} regex syntax does not respect the {{`m`}} flag');

      const regexOperator = operatorValue.ignoreCase ? ' ~* ?' : ' ~ ?';
      return new ParameterizedSQL(columnName + regexOperator, [operatorValue.source]);
    default:
      // invoke the base implementation of `buildExpression`
      return this.invokeSuper('buildExpression', columnName, operator, operatorValue, propertyDefinition);
  }
};

/**
 * Disconnect from PostgreSQL
 * @param {Function} [cb] The callback function
 */
PostgreSQL.prototype.disconnect = function disconnect(cb) {
  if (this.pg) {
    debug('Disconnecting from ' + this.settings.hostname);
    const pg = this.pg;
    this.pg = null;
    pg.end(); // This is sync
  }

  if (cb) {
    process.nextTick(cb);
  }
};

PostgreSQL.prototype.ping = function (cb) {
  this.execute('SELECT 1 AS result', [], cb);
};

PostgreSQL.prototype.getInsertedId = function (model, info) {
  const idColName = this.idColumn(model);
  let idValue;
  if (info && info[0]) {
    idValue = info[0][idColName];
  }
  return idValue;
};

/**
 * Build the SQL WHERE clause for the where object
 * @param {string} model Model name
 * @param {object} where An object for the where conditions
 * @returns {ParameterizedSQL} The SQL WHERE clause
 */
PostgreSQL.prototype.buildWhere = function (model, where) {
  const whereClause = this._buildWhere(model, where);
  if (whereClause.sql) {
    whereClause.sql = 'WHERE ' + whereClause.sql;
  }
  return whereClause;
};

/**
 * @private
 * @param model
 * @param where
 * @returns {ParameterizedSQL}
 */
PostgreSQL.prototype._buildWhere = function (model, where) {
  let columnValue, sqlExp;
  if (!where) {
    return new ParameterizedSQL('');
  }
  if (typeof where !== 'object' || Array.isArray(where)) {
    debug('Invalid value for where: %j', where);
    return new ParameterizedSQL('');
  }
  const self = this;
  const props = self.getModelDefinition(model).properties;

  const whereStmts = [];
  for (const key in where) {
    const stmt = new ParameterizedSQL('', []);
    // Handle and/or operators
    if (key === 'and' || key === 'or') {
      const branches = [];
      let branchParams = [];
      const clauses = where[key];
      if (Array.isArray(clauses)) {
        for (let i = 0, n = clauses.length; i < n; i++) {
          const stmtForClause = self._buildWhere(model, clauses[i]);
          if (stmtForClause.sql) {
            stmtForClause.sql = '(' + stmtForClause.sql + ')';
            branchParams = branchParams.concat(stmtForClause.params);
            branches.push(stmtForClause.sql);
          }
        }
        stmt.merge({
          sql: branches.join(' ' + key.toUpperCase() + ' '),
          params: branchParams,
        });
        whereStmts.push(stmt);
        continue;
      }
      // The value is not an array, fall back to regular fields
    }
    let p = props[key];

    if (p == null && isNested(key)) {
      // See if we are querying nested json
      p = props[key.split('.')[0]];
    }

    if (p == null) {
      // Unknown property, ignore it
      debug('Unknown property %s is skipped for model %s', key, model);
      continue;
    }
    // eslint-disable one-var
    let expression = where[key];
    const columnName = self.columnEscaped(model, key);
    // eslint-enable one-var
    if (expression === null || expression === undefined) {
      stmt.merge(columnName + ' IS NULL');
    } else if (expression && expression.constructor === Object) {
      const operator = Object.keys(expression)[0];
      // Get the expression without the operator
      expression = expression[operator];
      if (operator === 'inq' || operator === 'nin' || operator === 'between') {
        columnValue = [];
        if (Array.isArray(expression)) {
          // Column value is a list
          for (let j = 0, m = expression.length; j < m; j++) {
            columnValue.push(this.toColumnValue(p, expression[j], true));
          }
        } else {
          columnValue.push(this.toColumnValue(p, expression, true));
        }
        if (operator === 'between') {
          // BETWEEN v1 AND v2
          const v1 = columnValue[0] === undefined ? null : columnValue[0];
          const v2 = columnValue[1] === undefined ? null : columnValue[1];
          columnValue = [v1, v2];
        } else {
          // IN (v1,v2,v3) or NOT IN (v1,v2,v3)
          if (columnValue.length === 0) {
            if (operator === 'inq') {
              columnValue = [null];
            } else {
              // nin () is true
              continue;
            }
          }
        }
      } else if (operator === 'regexp' && expression instanceof RegExp) {
        // do not coerce RegExp based on property definitions
        columnValue = expression;
      } else {
        columnValue = this.toColumnValue(p, expression, true);
      }
      sqlExp = self.buildExpression(columnName, operator, columnValue, p);
      stmt.merge(sqlExp);
    } else {
      // The expression is the field value, not a condition
      columnValue = self.toColumnValue(p, expression);
      if (columnValue === null) {
        stmt.merge(columnName + ' IS NULL');
      } else {
        if (columnValue instanceof ParameterizedSQL) {
          if (p.type.name === 'GeoPoint') stmt.merge(columnName + '~=').merge(columnValue);
          else stmt.merge(columnName + '=').merge(columnValue);
        } else {
          stmt.merge({
            sql: columnName + '=?',
            params: [columnValue],
          });
        }
      }
    }
    whereStmts.push(stmt);
  }
  let params = [];
  const sqls = [];
  for (let k = 0, s = whereStmts.length; k < s; k++) {
    sqls.push(whereStmts[k].sql);
    params = params.concat(whereStmts[k].params);
  }
  const whereStmt = new ParameterizedSQL({
    sql: sqls.join(' AND '),
    params: params,
  });
  return whereStmt;
};

/*!
 * Convert property name/value to an escaped DB column value
 * @param {Object} prop Property descriptor
 * @param {*} val Property value
 * @param {boolean} isWhereClause
 * @returns {*} The escaped value of DB column
 */
PostgreSQL.prototype.toColumnValue = function (prop, val, isWhereClause) {
  if (val == null) {
    // PostgreSQL complains with NULLs in not null columns
    // If we have an autoincrement value, return DEFAULT instead
    // Do not return 'DEFAULT' for id field in where clause
    if (prop.autoIncrement || (prop.id && !isWhereClause)) {
      return new ParameterizedSQL('DEFAULT');
    } else {
      return null;
    }
  }
  if (prop.type === String) {
    return String(val);
  }
  if (prop.type === Number) {
    if (isNaN(val)) {
      // Map NaN to NULL
      return val;
    }
    return val;
  }

  if (prop.type === Date || prop.type.name === 'Timestamp') {
    if (!val.toISOString) {
      val = new Date(val);
    }
    const iso = val.toISOString();

    // Pass in date as UTC and make sure Postgresql stores using UTC timezone
    return new ParameterizedSQL({
      sql: '?::TIMESTAMP WITH TIME ZONE',
      params: [iso],
    });
  }

  // PostgreSQL support char(1) Y/N
  if (prop.type === Boolean) {
    if (val) {
      return true;
    } else {
      return false;
    }
  }

  if (prop.type.name === 'GeoPoint' || prop.type.name === 'Point') {
    return new ParameterizedSQL({
      sql: 'point(?,?)',
      // Postgres point is point(lng, lat)
      params: [val.lng, val.lat],
    });
  }

  return val;
};

/**
 * Get the place holder in SQL for identifiers, such as ??
 * @param {String} key Optional key, such as 1 or id
 * @returns {String} The place holder
 */
PostgreSQL.prototype.getPlaceholderForIdentifier = function (key) {
  throw new Error(g.f('{{Placeholder}} for identifiers is not supported'));
};

/**
 * Get the place holder in SQL for values, such as :1 or ?
 * @param {String} key Optional key, such as 1 or id
 * @returns {String} The place holder
 */
PostgreSQL.prototype.getPlaceholderForValue = function (key) {
  return '$' + key;
};

PostgreSQL.prototype.getCountForAffectedRows = function (model, info) {
  return info && info.affectedRows;
};

function isPlainObject(obj) {
  return typeof obj === 'object' && obj !== null && obj.constructor === Object;
}

PostgreSQL.prototype._normalizeIncludes = function (include) {
  let newInclude;
  if (typeof include === 'string') {
    return [{relation: include}];
  } else if (isPlainObject(include) && include.relation) {
    if (include.scope && include.scope.include) {
      include.scope.include = this._normalizeIncludes(include.scope.include);
    }
    return [include];
  } else if (Array.isArray(include)) {
    newInclude = [];
    for (let i = 0, n = include.length; i < n; i++) {
      newInclude = [...newInclude, ...this._normalizeIncludes(include[i])];
    }
    return newInclude;
  } else {
    return include;
  }
};

PostgreSQL.prototype._checkIncludes = function (model, include) {
  const currentModel = this._models[model];

  if (Array.isArray(include)) {
    for (const rel of include) {
      if (!currentModel.settings.relations[rel.relation]) {
        throw new Error(`The relation - ${rel.relation} does not exist.`);
      } else if (rel.scope && rel.scope.include) {
        this._checkIncludes(currentModel.settings.relations[rel.relation].model, rel.scope.include);
      }
    }
  } else {
    throw new Error('Include is not array');
  }
};

PostgreSQL.prototype._fieldsFromFilter = function (model, filter) {
  const fieldsFilter = filter && filter.fields;
  const cols = this.getModelDefinition(model).properties;
  if (!cols) {
    return '*';
  }
  const self = this;
  let keys = Object.keys(cols);
  if (Array.isArray(fieldsFilter) && fieldsFilter.length > 0) {
    // Not empty array, including all the fields that are valid properties
    keys = fieldsFilter.filter(function (f) {
      return cols[f];
    });
  } else if ('object' === typeof fieldsFilter && Object.keys(fieldsFilter).length > 0) {
    // { field1: boolean, field2: boolean ... }
    const included = [];
    const excluded = [];
    keys.forEach(function (k) {
      if (fieldsFilter[k]) {
        included.push(k);
      } else if (k in fieldsFilter && !fieldsFilter[k]) {
        excluded.push(k);
      }
    });
    if (included.length > 0) {
      keys = included;
    } else if (excluded.length > 0) {
      excluded.forEach(function (e) {
        const index = keys.indexOf(e);
        keys.splice(index, 1);
      });
    }
  }

  return keys;
};

PostgreSQL.prototype._buildConditionForRelation = function (parentModel, parentTableName, relationName) {
  const model = this.getModelDefinition(parentModel);
  const relation = model.settings.relations[relationName];

  switch (relation.type) {
    case 'belongsTo':
      return (
        parentTableName +
        '.' +
        this.columnEscaped(parentModel, relation.foreignKey) +
        '=' +
        this.columnEscaped(relation.model, 'id')
      );
    case 'hasOne':
    case 'hasMany':
      if (relation.modelThrough) {
        throw new Error('Through relation has not been implemented yet');
      }

      return (
        parentTableName +
        '.' +
        this.columnEscaped(parentModel, 'id') +
        '=' +
        this.columnEscaped(relation.model, relation.foreignKey)
      );
    default:
      throw new Error(`Relation: ${relation.type} is not implemented yet`);
  }
};

PostgreSQL.prototype._buildSelectWithAnchorToTable = function (
  parentModel,
  parentTableName,
  relationName,
  filter,
  options,
) {
  const model = this.getModelDefinition(parentModel).settings.relations[relationName].model;
  const baseSql = this.buildSelect(model, filter, options);

  const whereIndex = baseSql.sql.indexOf('WHERE');
  const relationCondition = this._buildConditionForRelation(parentModel, parentTableName, relationName);

  let afterConditionIndex = baseSql.sql.length;
  if (baseSql.sql.indexOf('ORDER BY')) {
    afterConditionIndex = baseSql.sql.indexOf('ORDER BY');
  } else if (baseSql.sql.indexOf('LIMIT')) {
    afterConditionIndex = baseSql.sql.indexOf('LIMIT');
  } else if (baseSql.sql.indexOf('OFFSET')) {
    afterConditionIndex = baseSql.sql.indexOf('OFFSET');
  }

  if (whereIndex === -1) {
    const beforeWhere = baseSql.sql.substring(0, afterConditionIndex - 1);
    const afterWhere = afterConditionIndex !== baseSql.sql.length ? baseSql.sql.substring(afterConditionIndex) : null;

    baseSql.sql = beforeWhere + ' WHERE ' + '(' + relationCondition + ')';

    if (afterWhere) {
      baseSql.sql += ' ' + afterWhere;
    }
  } else {
    const beforeWhere = baseSql.sql.substring(0, whereIndex - 1);
    const afterWhere = afterConditionIndex !== baseSql.sql.length ? baseSql.sql.substring(afterConditionIndex) : null;
    // copying without 'WHERE' keyword
    const oldWhere = baseSql.sql.substring(whereIndex + 5, afterConditionIndex - 1);

    baseSql.sql = beforeWhere + ' WHERE ' + '(' + oldWhere.trim() + ') AND (' + relationCondition + ')';

    if (afterWhere) {
      baseSql.sql += ' ' + afterWhere;
    }
  }

  return baseSql;
};

PostgreSQL.prototype._buildFields = function (queryParts) {
  const fields = [];

  queryParts.forEach((part) => {
    fields.push(
      ...part.fields.map((field) =>
        part.isMain
          ? part.tableName + '.' + this.columnEscaped(part.model, field)
          : part.tableName + '.' + this.columnEscaped(part.model, field) + ' AS ' + part.tableName + '_' + field),
    );
  });

  return fields.join(',');
};

PostgreSQL.prototype._buildQueryParts = function (model, filter, options) {
  const queryParts = [];

  const selectsToProccess = [
    {
      model,
      filter,
    },
  ];
  while (selectsToProccess.length) {
    const select = selectsToProccess.pop();
    const currentModel = select.parentModel
      ? this.getModelDefinition(select.parentModel).settings.relations[select.model].model
      : select.model;

    const sql = select.parentModel
      ? this._buildSelectWithAnchorToTable(select.parentModel, select.parentTable, select.model, select.filter, options)
      : this.buildSelect(select.model, select.filter, options);
    const tableName = select.parentTable ? select.parentTable + '_' + select.model : select.model;
    const fields = this._fieldsFromFilter(currentModel, select.filter);
    const order = select.filter.order || this.idNames(model);

    select.filter.fields = fields;

    queryParts.push({
      sql,
      tableName,
      fields,
      order,
      model: currentModel,
      isMain: !select.parentTable,
    });

    if (select.filter.include) {
      selectsToProccess.push(
        ...select.filter.include.map((include) => {
          include.scope = include.scope || {};
          return {
            model: include.relation,
            filter: include.scope,
            parentTable: tableName,
            parentModel: currentModel,
          };
        }));
    }
  }

  return queryParts;
};

PostgreSQL.prototype._incrementParamsInSQL = function (sql, incrementBy) {
  const matches = Array.from(sql.matchAll(/\$\d+/g), m => m);

  if (!matches.length) {
    return sql;
  }

  return matches.reduce((acc, curr, index) => {
    const incrementedParam = '$' + (Number(curr.substring(1)) + incrementBy);

    let beforeParamSql = "";
    let afterParamSql = "";
    if (index === 0) {
      beforeParamSql = sql.substring(0, curr.index - 1);
    } else {
      beforeParamSql = sql.substring(matches[index - 1].index + matches[index - 1].length, curr.index - 1);
    }

    if (index === matches - 1) {
      afterParamSql = sql.substring(curr.index + curr.length);
    }

    acc += beforeParamSql + incrementedParam + afterParamSql;

    return acc;
  }, "");
};

PostgreSQL.prototype._buildSelectWithInclude = function (model, filter, options) {
  const queryParts = this._buildQueryParts(model, filter, options);

  const mainSelect = queryParts.find(part => part.isMain);
  const subSelects = queryParts.filter(part => !part.isMain);

  const requestSql = mainSelect.sql;

  requestSql.sql =
    'WITH ' +
    mainSelect.tableName +
    ' AS (' +
    requestSql.sql +
    ')' +
    'SELECT ' +
    this._buildFields(queryParts) +
    ' FROM ' +
    mainSelect.tableName;
  subSelects.forEach((select) => {
    requestSql.sql += requestSql.sql + ' LEFT JOIN LATERAL (' + this._incrementParamsInSQL(select.sql.sql, resultSql.params) + ') AS ' + select.tableName + ' ON TRUE';
    resultSql.params.push(...select.sql.params);
    
    requestSql.merge(select.sql, ' LEFT JOIN LATERAL ');
  });

  const orders = [];
  queryParts.forEach((part) => {
    if (part.order && part.order.length) {
      orders.push(
        ...part.order.map((order) => {
          const t = order.split(/[\s,]+/);

          return t.length === 1
            ? part.tableName + '.' + this.columnEscaped(part.model, t[0])
            : part.tableName + '.' + this.columnEscaped(part.model, t[0]) + t[1];
        }),
      );
    }
  });

  requestSql.merge('ORDER BY ' + orders.join(','));

  return requestSql;
};

PostgreSQL.prototype._constructResponse = function (model, data, filter, options, cb) {
  this._extractModelsFromData(this, model, data, filter, options, null, null, (err, objs) => {
    cb(err, objs);
  });
};

PostgreSQL.prototype._extractModelsFromData = function (self, model, data, filter, options, dataPrefix, includeType, cb) {
  filter = filter || {};
  dataPrefix = dataPrefix || "";

  const idColumns = self.idNames(model);
  const modelDefinition = self.getModelDefinition(model);
  const Model = modelDefinition.model;

  const objs = data.map(function (row) {
    const data = self.fromRowWithPrefix(model, row, dataPrefix);

    if (dataPrefix !== "" && data) {
      return new Model(data, {
        fields: filter.fields,
        applySetters: false,
        persisted: true,
      });
    } else {
      return data;
    }
  });
  const groups = objs.reduce((acc, curr, index) => {
    if (!curr) return acc;
    const identifier = idColumns.map(column => curr[column]).join('-');

    if (!acc[identifier]) {
      acc[identifier] = {
        index,
        obj: curr,
        rows: [data[index]],
      };
    } else {
      acc[identifier].rows.push(data[index]);
    }

    return acc;
  }, {});

  const sortedGroups = Object.values(groups)
    .sort((left, right) => left.index - right.index);

  if (Array.isArray(filter.include) && filter.include.length) {
    Promise.all(sortedGroups.map(group =>
      Promise.resolve()
        .then(() => {
          const obj = group.obj;

          defineCachedRelations(obj);

          return Promise.all(filter.include.map(include =>
            self._extractModelsFromDataAsync(
              self,
              modelDefinition.settings.relations[include.relation].model,
              group.rows,
              include.scope,
              options,
              dataPrefix ? dataPrefix + '_' + include.relation : model + '_' + include.relation,
              modelDefinition.settings.relations[include.relation].type,
            )
          ))
        })
        .then(relations => {
          const obj = group.obj;

          relations.forEach((relation, index) => {
            obj.__cachedRelations[filter.include[index].relation] = relation;
          });

          return Promise.resolve(obj);
        })
    ))
      .then(objs => {
        cb(null, objs);
      })
      .catch(err => {
        cb(err, null);
      });
  } else {
    const uniqueObjs = sortedGroups
      .map(group => {
        const obj = group.obj;

        defineCachedRelations(obj);

        return obj;
      });

    switch (includeType) {
      case 'belongsTo':
      case 'hasOne':
        cb(null, uniqueObjs[0]);
        break;
      default:
        cb(null, uniqueObjs);
        break;
    }
  }
};

PostgreSQL.prototype._extractModelsFromDataAsync = Promise.promisify(PostgreSQL.prototype._extractModelsFromData);

PostgreSQL.prototype.fromRowWithPrefix = function (model, rowData, prefix) {
  prefix = prefix || "";

  if (rowData == null) {
    return rowData;
  }
  // checking if joined row contains some properties from the included model
  if (prefix && Object.keys(rowData)
    .filter(key => key.startsWith(this.dbName(prefix)))
    .every(key => !rowData[key])) {
    return null;
  }

  const props = this.getModelDefinition(model).properties;
  const data = {};
  for (const p in props) {
    const columnName = this.columnWithPrefix(model, p, prefix);
    // Load properties from the row
    const columnValue = this.fromColumnValue(props[p], rowData[columnName]);
    if (columnValue !== undefined) {
      data[p] = columnValue;
    }
  }
  return data;
};

PostgreSQL.prototype.columnWithPrefix = function (model, property, prefix) {
  prefix = prefix || '';
  if (prefix !== '') {
    prefix += '_';
  }

  const prop = this.getPropertyDefinition(model, property);
  let columnName;
  if (prop && prop[this.name]) {
    columnName = prop[this.name].column || prop[this.name].columnName;
    if (columnName) {
      // Explicit column name, return as-is
      return prefix + columnName;
    }
  }

  // Check if name attribute provided for column name
  if (prop && prop.name) {
    return prop.name;
  }
  columnName = property;
  if (typeof this.dbName === 'function') {
    columnName = this.dbNameWithPrefix(columnName, prefix);
  }
  return columnName;
};

function defineCachedRelations(obj) {
  if (!obj.__cachedRelations) {
    Object.defineProperty(obj, '__cachedRelations', {
      writable: true,
      enumerable: false,
      configurable: true,
      value: {},
    });
  }
}

PostgreSQL.prototype.all = function find(model, filter, options, cb) {
  const self = this;
  // Order by id if no order is specified
  filter = filter || {};

  let stmt;
  let queryParts;
  if (filter && filter.include) {
    filter.include = this._normalizeIncludes(filter.include);

    try {
      this._checkIncludes(model, filter.include);
    } catch (e) {
      return cb(e, null);
    }

    stmt = this._buildSelectWithInclude(model, filter, options);
  } else {
    stmt = this.buildSelect(model, filter, options);
  }

  this.execute(stmt.sql, stmt.params, options, function (err, data) {
    if (err) {
      return cb(err, []);
    }

    if (filter && filter.include) {
      self._constructResponse(model, data, filter, options, cb);
    } else {
      const objs = data.map(function (obj) {
        return self.fromRow(model, obj);
      });

      cb(null, objs);
    }
  });
};

require('./discovery')(PostgreSQL);
require('./migration')(PostgreSQL);
require('./transaction')(PostgreSQL);
