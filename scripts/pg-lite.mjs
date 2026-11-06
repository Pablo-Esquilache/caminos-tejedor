// Cliente PostgreSQL minimalista en puro Node.js (sin dependencias externas)
// Soporta TLS + autenticación SCRAM-SHA-256 / MD5 / Cleartext y Simple Query Protocol ('Q')
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

export class PgLiteClient {
  constructor(connectionString) {
    const url = new URL(connectionString);
    this.host = url.hostname;
    this.port = Number(url.port || 5432);
    this.user = decodeURIComponent(url.username);
    this.password = decodeURIComponent(url.password);
    this.database = decodeURIComponent(url.pathname.replace(/^\//, '') || 'postgres');
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.onNotice = null;
  }

  async connect() {
    // 1. Abrir socket TCP y negociar SSLRequest
    const rawSocket = await new Promise((resolve, reject) => {
      const s = net.connect(this.port, this.host, () => resolve(s));
      s.once('error', reject);
    });

    const sslReq = Buffer.alloc(8);
    sslReq.writeInt32BE(8, 0);
    sslReq.writeInt32BE(80877103, 4); // SSLRequest code
    rawSocket.write(sslReq);

    const sslResp = await new Promise((resolve, reject) => {
      rawSocket.once('data', resolve);
      rawSocket.once('error', reject);
    });

    if (sslResp[0] === 0x53) {
      // 'S' -> Servidor acepta TLS
      this.socket = await new Promise((resolve, reject) => {
        const tlsSocket = tls.connect(
          {
            socket: rawSocket,
            servername: this.host,
            rejectUnauthorized: false,
          },
          () => resolve(tlsSocket)
        );
        tlsSocket.once('error', reject);
      });
    } else {
      this.socket = rawSocket;
    }

    this.socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this._processBuffer();
    });

    // 2. Enviar StartupMessage (Protocol v3.0 = 196608)
    await this._authenticate();
  }

  _sendStartupMessage() {
    const params = [
      'user',
      this.user,
      'database',
      this.database,
      'client_encoding',
      'UTF8',
      '',
    ];
    const bodyStr = params.join('\0');
    const bodyBuf = Buffer.from(bodyStr, 'utf8');
    const len = 4 + 4 + bodyBuf.length;
    const buf = Buffer.alloc(len);
    buf.writeInt32BE(len, 0);
    buf.writeInt32BE(196608, 4);
    bodyBuf.copy(buf, 8);
    this.socket.write(buf);
  }

  _sendPasswordMessage(payloadBuf) {
    const len = 4 + payloadBuf.length;
    const buf = Buffer.alloc(1 + len);
    buf.write('p', 0, 'ascii');
    buf.writeInt32BE(len, 1);
    payloadBuf.copy(buf, 5);
    this.socket.write(buf);
  }

  async _authenticate() {
    return new Promise((resolve, reject) => {
      let clientNonce = '';
      let clientFirstMessageBare = '';
      let saltedPassword = null;
      let authMessage = '';

      this._messageHandler = (type, payload) => {
        try {
          if (type === 'R') {
            const authType = payload.readInt32BE(0);
            if (authType === 0) {
              // AuthenticationOk
              return;
            } else if (authType === 3) {
              // CleartextPassword
              const pw = Buffer.concat([Buffer.from(this.password, 'utf8'), Buffer.from([0])]);
              this._sendPasswordMessage(pw);
            } else if (authType === 5) {
              // MD5Password
              const salt = payload.subarray(4, 8);
              const inner = crypto
                .createHash('md5')
                .update(this.password + this.user, 'utf8')
                .digest('hex');
              const outer = crypto
                .createHash('md5')
                .update(Buffer.concat([Buffer.from(inner, 'ascii'), salt]))
                .digest('hex');
              const pw = Buffer.concat([Buffer.from('md5' + outer, 'ascii'), Buffer.from([0])]);
              this._sendPasswordMessage(pw);
            } else if (authType === 10) {
              // AuthenticationSASL (SCRAM-SHA-256)
              clientNonce = crypto.randomBytes(18).toString('base64');
              clientFirstMessageBare = `n=,r=${clientNonce}`;
              const clientFirstMessage = `n,,${clientFirstMessageBare}`;
              const msgBuf = Buffer.from(clientFirstMessage, 'utf8');
              const mech = Buffer.from('SCRAM-SHA-256\0', 'ascii');
              const lenBuf = Buffer.alloc(4);
              lenBuf.writeInt32BE(msgBuf.length, 0);
              this._sendPasswordMessage(Buffer.concat([mech, lenBuf, msgBuf]));
            } else if (authType === 11) {
              // AuthenticationSASLContinue
              const serverFirst = payload.subarray(4).toString('utf8');
              const parts = Object.fromEntries(
                serverFirst.split(',').map((kv) => [kv[0], kv.slice(2)])
              );
              const r = parts.r;
              const s = Buffer.from(parts.s, 'base64');
              const i = parseInt(parts.i, 10);

              if (!r.startsWith(clientNonce)) {
                throw new Error('SCRAM nonce inválido del servidor');
              }

              saltedPassword = crypto.pbkdf2Sync(this.password, s, i, 32, 'sha256');
              const clientKey = crypto
                .createHmac('sha256', saltedPassword)
                .update('Client Key')
                .digest();
              const storedKey = crypto.createHash('sha256').update(clientKey).digest();
              const clientFinalWithoutProof = `c=biws,r=${r}`;
              authMessage = `${clientFirstMessageBare},${serverFirst},${clientFinalWithoutProof}`;
              const clientSignature = crypto
                .createHmac('sha256', storedKey)
                .update(authMessage)
                .digest();
              const proof = Buffer.alloc(clientKey.length);
              for (let idx = 0; idx < clientKey.length; idx++) {
                proof[idx] = clientKey[idx] ^ clientSignature[idx];
              }
              const clientFinal = `${clientFinalWithoutProof},p=${proof.toString('base64')}`;
              this._sendPasswordMessage(Buffer.from(clientFinal, 'utf8'));
            } else if (authType === 12) {
              // AuthenticationSASLFinal
              return;
            } else {
              throw new Error(`Tipo de autenticación no soportado: ${authType}`);
            }
          } else if (type === 'E') {
            reject(this._parseError(payload));
          } else if (type === 'Z') {
            // ReadyForQuery
            this._messageHandler = null;
            resolve();
          }
        } catch (err) {
          reject(err);
        }
      };

      this._sendStartupMessage();
    });
  }

  async query(sql) {
    return new Promise((resolve, reject) => {
      const fields = [];
      const rows = [];
      let currentFields = [];
      let error = null;

      this._messageHandler = (type, payload) => {
        if (type === 'T') {
          // RowDescription
          const count = payload.readInt16BE(0);
          let offset = 2;
          currentFields = [];
          for (let i = 0; i < count; i++) {
            const end = payload.indexOf(0, offset);
            const name = payload.toString('utf8', offset, end);
            currentFields.push(name);
            offset = end + 1 + 18;
          }
          fields.push(...currentFields);
        } else if (type === 'D') {
          // DataRow
          const count = payload.readInt16BE(0);
          let offset = 2;
          const row = {};
          for (let i = 0; i < count; i++) {
            const colLen = payload.readInt32BE(offset);
            offset += 4;
            const colName = currentFields[i] || `col_${i}`;
            if (colLen === -1) {
              row[colName] = null;
            } else {
              const val = payload.toString('utf8', offset, offset + colLen);
              row[colName] = val === 't' ? true : val === 'f' ? false : val;
              offset += colLen;
            }
          }
          rows.push(row);
        } else if (type === 'N') {
          // NoticeResponse
          const msg = this._parseNotice(payload);
          if (this.onNotice) this.onNotice(msg);
        } else if (type === 'E') {
          error = this._parseError(payload);
        } else if (type === 'Z') {
          this._messageHandler = null;
          if (error) reject(error);
          else resolve({ rows, rowCount: rows.length });
        }
      };

      const sqlBuf = Buffer.concat([Buffer.from(sql, 'utf8'), Buffer.from([0])]);
      const msg = Buffer.alloc(1 + 4 + sqlBuf.length);
      msg.write('Q', 0, 'ascii');
      msg.writeInt32BE(4 + sqlBuf.length, 1);
      sqlBuf.copy(msg, 5);
      this.socket.write(msg);
    });
  }

  async end() {
    if (!this.socket) return;
    const term = Buffer.from([0x58, 0x00, 0x00, 0x00, 0x04]); // 'X' Terminate
    this.socket.write(term);
    this.socket.end();
  }

  _processBuffer() {
    while (this.buffer.length >= 5) {
      const type = String.fromCharCode(this.buffer[0]);
      const length = this.buffer.readInt32BE(1);
      if (this.buffer.length < 1 + length) break;
      const payload = this.buffer.subarray(5, 1 + length);
      this.buffer = this.buffer.subarray(1 + length);
      if (this._messageHandler) {
        this._messageHandler(type, payload);
      }
    }
  }

  _parseError(payload) {
    const fields = this._parseFields(payload);
    return new Error(`${fields.S || 'ERROR'}: ${fields.M || 'Database error'} (${fields.D || ''})`);
  }

  _parseNotice(payload) {
    const fields = this._parseFields(payload);
    return { message: fields.M || '' };
  }

  _parseFields(payload) {
    const res = {};
    let offset = 0;
    while (offset < payload.length && payload[offset] !== 0) {
      const code = String.fromCharCode(payload[offset]);
      offset += 1;
      const end = payload.indexOf(0, offset);
      res[code] = payload.toString('utf8', offset, end);
      offset = end + 1;
    }
    return res;
  }
}
