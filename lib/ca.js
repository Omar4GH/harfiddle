// Root CA + per-host leaf certificates for HTTPS interception.
// Keys are generated natively (fast); node-forge is only used to build/sign X.509 certs.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');
const net = require('net');
const forge = require('node-forge');

const pki = forge.pki;

function rsaPem() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs1', format: 'pem' });
}

function serial() {
  // positive, 16 random bytes
  const b = crypto.randomBytes(16);
  b[0] &= 0x7f;
  return b.toString('hex');
}

class CertAuthority {
  constructor(dir) {
    this.dir = dir;
    this.caCertPath = path.join(dir, 'harfiddle-ca.pem');
    this.caKeyPath = path.join(dir, 'harfiddle-ca-key.pem');
    this.cache = new Map();
    this._loadOrCreate();
    // One key shared by all leaf certs — cert signing is then ~ms per host.
    this.leafKeyPem = rsaPem();
    this.leafKey = pki.privateKeyFromPem(this.leafKeyPem);
    this.leafPub = pki.setRsaPublicKey(this.leafKey.n, this.leafKey.e);
  }

  _loadOrCreate() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (fs.existsSync(this.caCertPath) && fs.existsSync(this.caKeyPath)) {
      this.caCertPem = fs.readFileSync(this.caCertPath, 'utf8');
      this.caCert = pki.certificateFromPem(this.caCertPem);
      this.caKey = pki.privateKeyFromPem(fs.readFileSync(this.caKeyPath, 'utf8'));
      if (this.caCert.validity.notAfter > new Date()) return;
    }
    const keyPem = rsaPem();
    const key = pki.privateKeyFromPem(keyPem);
    const cert = pki.createCertificate();
    cert.publicKey = pki.setRsaPublicKey(key.n, key.e);
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date(Date.now() - 86400e3);
    cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 86400e3);
    const attrs = [
      { name: 'commonName', value: 'HarFiddle Root CA' },
      { name: 'organizationName', value: 'HarFiddle (local debugging proxy)' },
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
      { name: 'subjectKeyIdentifier' },
    ]);
    cert.sign(key, forge.md.sha256.create());
    this.caCert = cert;
    this.caKey = key;
    this.caCertPem = pki.certificateToPem(cert);
    fs.writeFileSync(this.caCertPath, this.caCertPem);
    fs.writeFileSync(this.caKeyPath, keyPem, { mode: 0o600 });
  }

  fingerprint() {
    const der = forge.asn1.toDer(pki.certificateToAsn1(this.caCert)).getBytes();
    return forge.md.sha1.create().update(der).digest().toHex().toUpperCase().match(/../g).join(':');
  }

  _leafPem(host) {
    const cert = pki.createCertificate();
    cert.publicKey = this.leafPub;
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date(Date.now() - 86400e3);
    cert.validity.notAfter = new Date(Date.now() + 365 * 86400e3); // Apple/Chrome cap leafs at 398 days
    cert.setSubject([{ name: 'commonName', value: host.slice(0, 64) }]);
    cert.setIssuer(this.caCert.subject.attributes);
    const altNames = net.isIP(host) ? [{ type: 7, ip: host }] : [{ type: 2, value: host }];
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
      { name: 'authorityKeyIdentifier', keyIdentifier: this.caCert.generateSubjectKeyIdentifier().getBytes() },
    ]);
    cert.sign(this.caKey, forge.md.sha256.create());
    return pki.certificateToPem(cert);
  }

  contextFor(host) {
    host = String(host || 'localhost').toLowerCase().replace(/^\[|\]$/g, '');
    let ctx = this.cache.get(host);
    if (ctx) {
      this.cache.delete(host); // keep most recently used last
    } else {
      ctx = tls.createSecureContext({ key: this.leafKeyPem, cert: this._leafPem(host) + this.caCertPem });
      if (this.cache.size >= 2000) this.cache.delete(this.cache.keys().next().value); // clients choose names freely
    }
    this.cache.set(host, ctx);
    return ctx;
  }
}

module.exports = { CertAuthority };
