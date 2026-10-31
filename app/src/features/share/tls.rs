//! The shared chat's encryption: TLS with a certificate made fresh for each share (nobody
//! signs it), which the guest checks against the fingerprint in its invite link instead.

use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, WebPkiSupportedAlgorithms, ring};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, ServerConfig, SignatureScheme};

use crate::runtime::Error;

fn provider() -> Arc<CryptoProvider> {
    Arc::new(ring::default_provider())
}

/// A certificate's fingerprint, as the link carries it.
pub(super) fn fingerprint(cert: &[u8]) -> String {
    blake3::hash(cert).to_hex().to_string()
}

/// A one-time token: 256 random bits, as hex.
pub(super) fn token() -> Result<String, Error> {
    let mut b = [0u8; 32];
    provider()
        .secure_random
        .fill(&mut b)
        .map_err(|_| Error::from("Couldn't make a secret for the link."))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// The host's side: a new certificate, and its fingerprint.
pub(super) fn server() -> Result<(Arc<ServerConfig>, String), Error> {
    let made = rcgen::generate_simple_self_signed(vec!["c-bot.local".to_string()])
        .map_err(|e| Error::from(format!("Couldn't make the share's certificate: {e}")))?;
    let cert = made.cert.der().clone();
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(made.signing_key.serialize_der()));
    let print = fingerprint(&cert);
    let config = ServerConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .and_then(|b| b.with_no_client_auth().with_single_cert(vec![cert], key))
        .map_err(|e| Error::from(format!("Couldn't set up encryption: {e}")))?;
    Ok((Arc::new(config), print))
}

/// The guest's side: only the certificate with this fingerprint will do.
pub(super) fn client(fingerprint: &str) -> Result<Arc<ClientConfig>, Error> {
    let p = provider();
    let pinned = Pinned {
        fingerprint: fingerprint.to_ascii_lowercase(),
        algorithms: p.signature_verification_algorithms,
    };
    let config = ClientConfig::builder_with_provider(p)
        .with_safe_default_protocol_versions()
        .map_err(|e| Error::from(format!("Couldn't set up encryption: {e}")))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(pinned))
        .with_no_client_auth();
    Ok(Arc::new(config))
}

/// The name the guest asks for (any will do: the certificate is checked by its fingerprint).
pub(super) fn name() -> ServerName<'static> {
    ServerName::try_from("c-bot.local").expect("a constant, valid name")
}

/// Trusts the one certificate whose fingerprint the link gave, and checks that the host
/// really holds its key (the handshake's signatures).
#[derive(Debug)]
struct Pinned {
    fingerprint: String,
    algorithms: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if fingerprint(end_entity) == self.fingerprint {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(
                "not the C-Bot the link was for".into(),
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::thread;

    use rustls::{ClientConnection, ServerConnection, StreamOwned};

    use super::*;

    // (to a host whose certificate isn't the one `print` names)
    fn talk(print: &str) -> Result<String, std::io::Error> {
        let (server, _) = server().unwrap();
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let at = l.local_addr().unwrap();
        let host = thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            let mut tls = StreamOwned::new(ServerConnection::new(server).unwrap(), s);
            let _ = tls.write_all(b"hi\n");
            let _ = tls.flush();
        });
        let s = TcpStream::connect(at).unwrap();
        let mut tls = StreamOwned::new(
            ClientConnection::new(client(print).unwrap(), name()).unwrap(),
            s,
        );
        let mut got = [0u8; 3];
        let r = tls
            .read_exact(&mut got)
            .map(|_| String::from_utf8_lossy(&got).into());
        drop(tls); // (hung up: the host's side stops waiting for the handshake)
        let _ = host.join();
        r
    }

    #[test]
    fn a_token_is_long_and_new_each_time() {
        let (a, b) = (token().unwrap(), token().unwrap());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }

    #[test]
    fn the_guest_refuses_a_certificate_the_link_didnt_name() {
        assert!(talk(&"0".repeat(64)).is_err());
    }

    #[test]
    fn the_guest_talks_to_the_certificate_the_link_named() {
        // (the server makes its own certificate: let it tell us its fingerprint first)
        let (server, print) = server().unwrap();
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let at = l.local_addr().unwrap();
        let host = thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            let mut tls = StreamOwned::new(ServerConnection::new(server).unwrap(), s);
            tls.write_all(b"hi\n").unwrap();
            tls.flush().unwrap();
        });
        let s = TcpStream::connect(at).unwrap();
        let mut tls = StreamOwned::new(
            ClientConnection::new(client(&print).unwrap(), name()).unwrap(),
            s,
        );
        let mut got = [0u8; 3];
        tls.read_exact(&mut got).unwrap();
        host.join().unwrap();
        assert_eq!(&got, b"hi\n");
    }
}
