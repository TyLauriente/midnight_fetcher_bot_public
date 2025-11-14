import paramiko
import time
import sys
import os
import concurrent.futures

MAX_WORKERS = 15

HOSTS = [
    "1eblzyiodqi9y3-64410b5b@ssh.runpod.io",
    "4u0hqt04vdbsgz-64410b2f@ssh.runpod.io",
    "hmkwc7uijg30yh-64410b38@ssh.runpod.io",
    "hwo8ofj0qw7ees-64410b38@ssh.runpod.io",
    "e4y12rltm8u9fl-64410bd1@ssh.runpod.io",
    "n4c2wt1nzdwu6u-64410b05@ssh.runpod.io",
    "38c15qumr609fy-64410ffb@ssh.runpod.io",
    "2anl3jzxzzdady-64410b77@ssh.runpod.io",
    "3w2yvbzn5t9e22-64410b38@ssh.runpod.io",
    "wiod5bhb33tjuy-64410ff1@ssh.runpod.io",
    "qnf7z3rw6f2srl-64411a5d@ssh.runpod.io",
    "el3wtriqlctdbf-64410bdd@ssh.runpod.io",
    "cti1e645lgvenh-64410ffb@ssh.runpod.io",
    "9m8psrhia6vfl4-64410b42@ssh.runpod.io",
    "zpvtnxvj63g00m-64410bf0@ssh.runpod.io",
    "hftlhxxre0aa1l-64410b5b@ssh.runpod.io",
    "0dx22qrxw98kfo-64410b18@ssh.runpod.io",
    "fajlsj4hbhshlt-64410b5b@ssh.runpod.io",
    "7001dkz2sfh2ao-64410b42@ssh.runpod.io",
    "ubcp8yl1xwrthx-64410b43@ssh.runpod.io",
    "cm8sc2isw5ooti-64410b2f@ssh.runpod.io",
    "55kegmdv7yan4a-64410b42@ssh.runpod.io",
    "sksvxa5agenajc-64411dd3@ssh.runpod.io",
    "n5kh02ks9lixqn-64410b05@ssh.runpod.io",
    "koi7kov1iwei1a-64410b32@ssh.runpod.io",
    "dbthr1k3ygvz8f-64410b38@ssh.runpod.io",
    "tge7002n8y1g88-64410b5b@ssh.runpod.io",
    "athq1ymdk0l5e5-64411dd3@ssh.runpod.io",
    "tmtq8j36lkjon6-64410b5b@ssh.runpod.io",
    "1lummya06f31w4-64410b42@ssh.runpod.io",
    "q52f2ost29yitx-64410bca@ssh.runpod.io",
    "0ihhjh1zn56nrb-64410b32@ssh.runpod.io",
    "n3zemki8vqt3q9-64410bdd@ssh.runpod.io"
]

UPDATE_ALL = False
ACTIVE_HOSTS = [
    "1eblzyiodqi9y3-64410b5b@ssh.runpod.io",
]

SSH_KEY = os.path.expanduser("~/.ssh/id_ed25519")
SESSION_NAME = "midnightbot"
SETUP_COMMAND = (
    "cd midnight_fetcher_bot_public/ && "
    "git fetch origin main && "
    "git reset --hard origin/main && "
    "sh setup.sh"
)

ATTACH_DURATION = 1
DEFAULT_WORKER_THREADS = 200
DEFAULT_BATCH_SIZE = 850

def stream_output(channel, timeout=None):
    start = time.time()
    buffer = ""
    while True:
        if channel.recv_ready():
            data = channel.recv(4096).decode("utf-8", errors="ignore")
            sys.stdout.write(data)
            sys.stdout.flush()
            buffer += data
        if channel.recv_stderr_ready():
            data = channel.recv_stderr(4096).decode("utf-8", errors="ignore")
            sys.stdout.write(data)
            sys.stdout.flush()
            buffer += data

        if timeout and time.time() - start > timeout:
            break
        if channel.exit_status_ready():
            break
        time.sleep(0.05)
    return buffer


def run_host(host, iteration):
    print(f"\n--- Connecting to {host} ---\n")

    username, hostname = host.split("@")
    key = paramiko.Ed25519Key.from_private_key_file(SSH_KEY)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        hostname=hostname,
        username=username,
        pkey=key,
        allow_agent=False,
        look_for_keys=False
    )

    channel = client.invoke_shell(width=200, height=50)

    channel.send(f"tmux send-keys -t {SESSION_NAME} C-c\n")
    channel.send(f"tmux send-keys -t {SESSION_NAME} C-c\n")
    stream_output(channel, timeout=1)

    channel.send(f'sed -i "s/\\"addressOffset\\":[ ]*[0-9]\\+/\\"addressOffset\\": {iteration}/" {"midnight_fetcher_bot_public/secure/mining-config.json"}\n')
    channel.send(f'sed -i "s/\\"workerThreads\\":[ ]*[0-9]\\+/\\"workerThreads\\": {DEFAULT_WORKER_THREADS}/" {"midnight_fetcher_bot_public/secure/mining-config.json"}\n')
    channel.send(f'sed -i "s/\\"batchSize\\":[ ]*[0-9]\\+/\\"batchSize\\": {DEFAULT_BATCH_SIZE}/" {"midnight_fetcher_bot_public/secure/mining-config.json"}\n')
    stream_output(channel, timeout=1)

    channel.send(SETUP_COMMAND + "\n")
    stream_output(channel, timeout=3)

    print(f"--- Finished with {host} ---\n")
    client.close()


def main():
    tasks = []
    iteration = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        for host in HOSTS:
            if iteration > 12:
                iteration = 0
            if UPDATE_ALL or host in ACTIVE_HOSTS:
                tasks.append(executor.submit(run_host, host, iteration))
            iteration += 1

        for t in tasks:
            t.result()


if __name__ == "__main__":
    main()
