#!/usr/bin/env python3
# Author: Jiajun (Carson) Chen
# email: jic4015@med.cornell.edu
"""Download the official NHIS 2024 adult file and run the survey summary.

Requirements: Python 3 standard library; R with survey and jsonlite installed.
System curl is used if Python cannot discover a sufficient certificate store.
Run from any directory: python3 scripts/nhis.py
Raw data stay in .work/ and must not be included in the published website.
"""
import argparse
from datetime import datetime
from hashlib import sha256
import json
from pathlib import Path
import shutil
import ssl
import subprocess
from urllib.request import urlopen
from urllib.error import URLError
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
URL = "https://ftp.cdc.gov/pub/health_Statistics/nchs/Datasets/NHIS/2024/adult24csv.zip"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument(
    "--refresh", action="store_true", help="Download a fresh source snapshot"
)
args = parser.parse_args()
work = ROOT / ".work"
work.mkdir(exist_ok=True)
archive = work / "nhis-adult24csv.zip"
provenance_file = work / "nhis-provenance.json"
if args.refresh or not archive.exists():
    context = ssl.create_default_context()
    # Python.org macOS installations may not discover the operating-system CA
    # bundle automatically. Add it when available; keep TLS verification on.
    system_ca = Path("/etc/ssl/cert.pem")
    if system_ca.exists():
        context.load_verify_locations(cafile=str(system_ca))
    temporary_archive = archive.with_suffix(".zip.download")
    try:
        with (
            urlopen(URL, timeout=120, context=context) as response,
            temporary_archive.open("wb") as output,
        ):
            shutil.copyfileobj(response, output)
    except URLError as error:
        # macOS curl can use the system trust store even when a separately
        # installed Python cannot. Never disable verification in either client.
        if not isinstance(
            error.reason, ssl.SSLCertVerificationError
        ) or not shutil.which("curl"):
            raise
        print(
            "Using system curl with certificate verification for the NHIS download."
        )
        subprocess.run(
            [
                "curl",
                "--location",
                "--fail",
                "--silent",
                "--show-error",
                "--max-time",
                "120",
                URL,
                "--output",
                str(temporary_archive),
            ],
            check=True,
        )
    with ZipFile(temporary_archive) as downloaded:
        if downloaded.testzip() is not None:
            raise ValueError(
                "Downloaded NHIS archive did not pass its integrity check"
            )
    temporary_archive.replace(archive)
    accessed = datetime.now().astimezone().date().isoformat()
elif provenance_file.exists():
    accessed = json.loads(provenance_file.read_text())["accessed"]
else:
    # For a user-supplied cached archive, this records the verification date.
    accessed = datetime.now().astimezone().date().isoformat()
out_dir = work / "nhis"
out_dir.mkdir(exist_ok=True)
with ZipFile(archive) as z:
    # Extract only the known data member; never trust archive paths.
    members = [n for n in z.namelist() if Path(n).name == "adult24.csv"]
    if len(members) != 1:
        raise ValueError(
            "Expected exactly one adult24.csv in the official archive"
        )
    csv_path = out_dir / "adult24.csv"
    csv_path.write_bytes(z.read(members[0]))
provenance = {
    "url": URL,
    "landing_page": "https://www.cdc.gov/nchs/nhis/documentation/2024-nhis.html",
    "codebook_url": "https://ftp.cdc.gov/pub/Health_Statistics/NCHS/Dataset_Documentation/NHIS/2024/Adult-codebook.pdf",
    "survey_description_url": "https://ftp.cdc.gov/pub/Health_Statistics/NCHS/Dataset_Documentation/NHIS/2024/srvydesc-508.pdf",
    "codebook_version": "18 June 2025",
    "accessed": accessed,
    "file": "adult24.csv",
    "archive_sha256": sha256(archive.read_bytes()).hexdigest(),
    "sha256": sha256(csv_path.read_bytes()).hexdigest(),
}
provenance_file.write_text(json.dumps(provenance, indent=2) + "\n")
subprocess.run(
    ["Rscript", str(ROOT / "scripts" / "nhis.R"), str(ROOT)], check=True
)
