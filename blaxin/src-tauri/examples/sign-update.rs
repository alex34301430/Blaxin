// ═══════════════════════════════════════════════════════════════════════
// BLAXIN — test signing tool (local E2E of the update pipeline)
//
// Generates a throwaway minisign keypair and signs a release artifact the
// same way CI signs the real .deb (same algorithm/format). The production
// pipeline signs with the real key stored in GitHub secrets; this tool
// only exists so the automatic-update flow can be exercised end to end
// with real cryptography but a disposable key.
//
// Usage:
//   cargo run --example sign-update -- <file> <out-pubkey-b64> <out-sig-text>
//
// The public key goes into BLAXIN_UPDATE_PUBKEY and the signature text into
// the manifest "deb"/"signature" field (or base64 of it).
// ═══════════════════════════════════════════════════════════════════════
use std::fs;
use std::io::Read;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 {
        eprintln!("usage: sign-update <file> <out-pubkey-b64> <out-sig-text>");
        return ExitCode::FAILURE;
    }
    let (file, pub_out, sig_out) = (&args[1], &args[2], &args[3]);

    let mut data = Vec::new();
    fs::File::open(file)
        .and_then(|mut f| f.read_to_end(&mut data))
        .unwrap_or_else(|e| {
            eprintln!("cannot read {}: {e}", file);
            std::process::exit(1);
        });

    let kp = minisign::KeyPair::generate_unencrypted_keypair().unwrap_or_else(|e| {
        eprintln!("keypair generation failed: {e}");
        std::process::exit(1);
    });
    let pk = kp.pk;
    let sig = minisign::sign(Some(&pk), &kp.sk, data.as_slice(), None, None)
        .unwrap_or_else(|e| {
            eprintln!("signing failed: {e}");
            std::process::exit(1);
        });

    fs::write(pub_out, pk.to_base64()).unwrap();
    fs::write(sig_out, sig.to_string()).unwrap();
    eprintln!("✓ signed {file}");
    eprintln!("public key:  {}", pk.to_base64());
    eprintln!("signature:   {} chars", sig.to_string().len());
    ExitCode::SUCCESS
}
