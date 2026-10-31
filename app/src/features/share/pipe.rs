//! A byte stream over channels: one person's connection through the relay (relay.rs), so the
//! same TLS and the same messages run over it as over the office network. Reading waits a
//! moment and then says "nothing yet", as a socket with a read timeout does (what wire.rs's
//! Lines expects); it ends when the other side closes.

use std::io::{self, Read, Write};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::Duration;

/// The most a frame to the relay carries (it takes up to 1 MB; TLS records are 16 KB).
pub(super) const FRAME_MAX: usize = 64 * 1024;

/// What goes out: whose connection it is, and its bytes (none: it closed).
pub(super) type Outgoing = Sender<(u32, Vec<u8>)>;

pub(super) struct Pipe {
    peer: u32,
    rx: Receiver<Vec<u8>>, // (what came in for it: empty when the other side closed)
    tx: Outgoing,
    left: Vec<u8>, // (what came in that wasn't read yet)
    wait: Duration,
    closed: bool,
}

impl Pipe {
    pub(super) fn new(peer: u32, rx: Receiver<Vec<u8>>, tx: Outgoing, wait: Duration) -> Pipe {
        Pipe {
            peer,
            rx,
            tx,
            left: Vec::new(),
            wait,
            closed: false,
        }
    }
}

impl Read for Pipe {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.left.is_empty() && !self.closed {
            match self.rx.recv_timeout(self.wait) {
                Ok(bytes) if bytes.is_empty() => self.closed = true,
                Ok(bytes) => self.left = bytes,
                Err(RecvTimeoutError::Timeout) => return Err(io::ErrorKind::WouldBlock.into()),
                Err(RecvTimeoutError::Disconnected) => self.closed = true,
            }
        }
        let n = buf.len().min(self.left.len());
        buf[..n].copy_from_slice(&self.left[..n]);
        self.left.drain(..n);
        Ok(n)
    }
}

impl Write for Pipe {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let n = buf.len().min(FRAME_MAX);
        self.tx
            .send((self.peer, buf[..n].to_vec()))
            .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for Pipe {
    /// Done with: the relay closes that person's connection.
    fn drop(&mut self) {
        let _ = self.tx.send((self.peer, Vec::new()));
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;

    type Ends = (Pipe, Sender<Vec<u8>>, Receiver<(u32, Vec<u8>)>);

    fn pipe() -> Ends {
        let (tx_in, rx_in) = mpsc::channel();
        let (tx_out, rx_out) = mpsc::channel();
        (
            Pipe::new(7, rx_in, tx_out, Duration::from_millis(5)),
            tx_in,
            rx_out,
        )
    }

    #[test]
    fn what_comes_in_is_read_in_pieces() {
        let (mut p, tx, _) = pipe();
        tx.send(b"hello".to_vec()).unwrap();
        let mut b = [0u8; 3];
        assert_eq!(p.read(&mut b).unwrap(), 3);
        assert_eq!(&b, b"hel");
        assert_eq!(p.read(&mut b).unwrap(), 2);
        assert_eq!(&b[..2], b"lo");
    }

    #[test]
    fn nothing_yet_is_would_block_and_a_close_is_the_end() {
        let (mut p, tx, _) = pipe();
        let mut b = [0u8; 4];
        assert_eq!(
            p.read(&mut b).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        tx.send(Vec::new()).unwrap();
        assert_eq!(p.read(&mut b).unwrap(), 0);
        assert_eq!(p.read(&mut b).unwrap(), 0);
    }

    #[test]
    fn writes_go_out_with_its_number_in_frames_and_dropping_closes() {
        let (mut p, _tx, out) = pipe();
        p.write_all(&vec![1u8; FRAME_MAX + 10]).unwrap();
        let (peer, first) = out.recv().unwrap();
        assert_eq!((peer, first.len()), (7, FRAME_MAX));
        assert_eq!(out.recv().unwrap().1.len(), 10);
        drop(p);
        assert_eq!(out.recv().unwrap(), (7, Vec::new()));
    }
}
