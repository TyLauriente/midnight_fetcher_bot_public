import paramiko
import time
import sys
import os
import concurrent.futures

MAX_WORKERS = 15

HOSTS = [
    "rgdycqvymzixii-64410b91@ssh.runpod.io",
    "7f52svaavqpika-64410b89@ssh.runpod.io",
    "13z3omod32xofy-64410b8f@ssh.runpod.io",
    "ubj1e029i609z1-64410e87@ssh.runpod.io",
    "aczuucle04dwfv-64410c98@ssh.runpod.io",
    "muf61mz6skkj15-64410d34@ssh.runpod.io",
    "od6699nirg7gsj-64410e87@ssh.runpod.io",
    "gg9maerrqhkwe8-64411b64@ssh.runpod.io",
    "hqmdj1ezjb5tok-64411b65@ssh.runpod.io",
    "vwkh33gv0el4l6-64411b6f@ssh.runpod.io",
    "wyeokucsd9f1ld-64411b71@ssh.runpod.io",
    "3jodwwqf0elifv-64411b78@ssh.runpod.io",
    "2e0fntc8d9nnru-64411ae0@ssh.runpod.io",
    "mj7agqtjh1hrnv-64411aa1@ssh.runpod.io",
    "52s7zek876jh6s-64410d32@ssh.runpod.io",
    "4rc5sg9qhg3ws2-64411cbd@ssh.runpod.io",
    "4x4r91mibbymru-64411b6c@ssh.runpod.io",
    "gki32rakmyasvm-64410b89@ssh.runpod.io",
    "fqglojlxkopinw-64411b85@ssh.runpod.io",
    "c6er5oajh8xqit-64411a02@ssh.runpod.io",
    "fqjju6h2xuridc-64410d3e@ssh.runpod.io",
    "gnqxesex4kxadb-64411a89@ssh.runpod.io",
    "6aur1jziu03eza-64411bb5@ssh.runpod.io",
    "1efia1k4ryq21l-64411b81@ssh.runpod.io",
    "h7inewwmqp6t9i-64411421@ssh.runpod.io",
    "nio5rlsrae8c8i-64411bbf@ssh.runpod.io",
    "08fmcc0tpsv3cp-6441154f@ssh.runpod.io",
    "ob7amr23dki0r1-64410fe2@ssh.runpod.io",
    "zod61ho1as5z74-64411bd4@ssh.runpod.io",
    "ghu0fvood5u2t1-64410a9c@ssh.runpod.io",
    "x28k6hizllmwu2-64411dde@ssh.runpod.io",
    "2tvqrfq6k32iot-64411b7e@ssh.runpod.io",
    "vm497rygyiqnhj-64411dac@ssh.runpod.io",
    "j1xhzyxw8gfygm-64411bee@ssh.runpod.io",
    "3rcxcqodgejvi8-64410f53@ssh.runpod.io",
    "m3vtt2q3f7wgap-64411ad0@ssh.runpod.io",
    "022rdb988o1kb5-644117e9@ssh.runpod.io",
    "lv82chwkf4gwg9-64410b91@ssh.runpod.io",
    "cmx1u2tp40ov27-64410fde@ssh.runpod.io",
    "4g88rfqzng1q7b-64411bb5@ssh.runpod.io",
    "91ybogd2trj4l9-64411aa1@ssh.runpod.io",
    "yzp0rw7qjz4we5-64411bbb@ssh.runpod.io",
    "94mzasda8f3zgx-64411b77@ssh.runpod.io"
]

JOSH_HOSTS = [
    "sv8500nnlmyz3c-64410ffb@ssh.runpod.io",
    "ts2mtznqxnmibw-64410b31@ssh.runpod.io",
    "3tyu7vajdcsntx-64410b32@ssh.runpod.io",
    "5naue6ipemtkx3-64410b42@ssh.runpod.io",
    "2jj7do4lapyzm3-64410b5b@ssh.runpod.io",
    "maugfquj9tpzka-64410b05@ssh.runpod.io",
    "yixi69ladnluf0-64410bdd@ssh.runpod.io",
    "6knk547p5e2z7h-64410b38@ssh.runpod.io",
    "gtembi602oud8z-64410b5b@ssh.runpod.io",
    "t8qz8lduiuhh94-64410b31@ssh.runpod.io",
    "zlc7btf3mr95k2-64410b05@ssh.runpod.io",
    "mzh57px29ues08-64410bd1@ssh.runpod.io",
    "oz673g3b5gg7sk-64410bdd@ssh.runpod.io",
    "o84zn9rhpy9bng-64411d17@ssh.runpod.io",
    "2uwsyuqhuefgah-64410e4f@ssh.runpod.io",
    "yf3c2zvxhwo1s1-64411df5@ssh.runpod.io",
    "s7xqzr3hy5cxfa-64411462@ssh.runpod.io",
    "qpgvf81qnmy2sp-64411a7b@ssh.runpod.io",
    "q0w560s0qwpl8q-644114e5@ssh.runpod.io",
    "drtskfglh5crgd-64410e0d@ssh.runpod.io",
    "6pgvpk2mpz12nt-64410b2f@ssh.runpod.io",
    "uyejai9zsf5a7n-64410b77@ssh.runpod.io",
    "1zy74eymf6rhxl-64410b42@ssh.runpod.io",
    "iz4qa0iz4gn67v-64410b77@ssh.runpod.io",
    "njajhwjsse3sci-64410b42@ssh.runpod.io",
    "ihdft1kt9pxgnc-64410bf0@ssh.runpod.io",
    "evbinxwhjskawq-64410ffb@ssh.runpod.io",
    "oxdi6rr13ytweq-64411112@ssh.runpod.io",
    "rszl1hu72ktq6y-64410a02@ssh.runpod.io",
    "xueq3w34unm21r-64411413@ssh.runpod.io",
    "7nbtc7t2u9vx9w-64411a83@ssh.runpod.io",
    "qreje0jxckhrds-64410ab7@ssh.runpod.io",
    "0pbgye2xrobtgt-64411d61@ssh.runpod.io",
    "fdibgekczlm4zr-64410b2f@ssh.runpod.io",
    "nhldcndty4cgjw-64411249@ssh.runpod.io",
    "85k6iqlus5ufwm-64411beb@ssh.runpod.io",
    "c6clv0hju9auxy-6441112e@ssh.runpod.io",
    "e3uo7oxegfhus6-64411df3@ssh.runpod.io",
    "6cxsswmtoheuhj-6441157f@ssh.runpod.io",
    "bq3yiousku3y5l-64411080@ssh.runpod.io",
    "u0v1cl7gg5f0iz-64410b77@ssh.runpod.io",
    "wudxiyqwsz1pfa-64411531@ssh.runpod.io",
    "4n6pw8dqkqfxyx-64410bd1@ssh.runpod.io",
    "8uldyfwr2fsfyh-64411578@ssh.runpod.io",
    "7n5i992isbrutg-64411348@ssh.runpod.io",
    "427jsokz41n5eq-64411224@ssh.runpod.io",
    "2etlzn8ycdidio-64410e08@ssh.runpod.io",
    "ka33s3mm54ogx1-64411487@ssh.runpod.io",
    "8iz41oepkwi9es-6441144e@ssh.runpod.io",
    "hffagyxbc2a2ox-644115fe@ssh.runpod.io",
    "melvuq84vnylvb-644111a9@ssh.runpod.io",
    "u6c58cq5inw6ps-6441152c@ssh.runpod.io",
    "fnitkiof1lmkli-64411481@ssh.runpod.io",
    "yhbs8eouamumi9-64410ed7@ssh.runpod.io",
    "olcfyrpgn1f0cj-6441164a@ssh.runpod.io",
    "f7qpkk67ar5iwe-64411d9d@ssh.runpod.io",
    "86ca3kjkbj8alb-6441107f@ssh.runpod.io",
    "pm4lmu6euawaji-644111a4@ssh.runpod.io",
    "5p8k7teive9oh1-64411376@ssh.runpod.io",
    "djww6wy8g4d5k9-64410b38@ssh.runpod.io",
    "dxwt9cuikt7wj7-64411506@ssh.runpod.io",
    "i6ds2scvw18yio-6441123e@ssh.runpod.io",
    "b7l426suyxm83f-644114da@ssh.runpod.io",
    "8yehg7sgkchtip-644115c8@ssh.runpod.io",
    "lqtzhxdc0dbq6v-644111b0@ssh.runpod.io",
    "8agwck4d0sc2ha-644114e2@ssh.runpod.io",
    "0wr34ll2dnki4m-64410efa@ssh.runpod.io",
    "2tgxkg383d60to-644111c1@ssh.runpod.io",
    "irk89h2i14c6gz-6441150a@ssh.runpod.io",
    "7gxcbvrc0mu4ss-64410d3f@ssh.runpod.io",
    "tz5jvdxyku4grc-64410b43@ssh.runpod.io",
    "o48r4pkne85mqa-64410b18@ssh.runpod.io",
    "flkdsl5fo04vll-64410b18@ssh.runpod.io",
    "m713yuv3pqbwm4-644113e5@ssh.runpod.io",
    "fcsuanhoiki72h-64410fba@ssh.runpod.io",
    "nvplw0b8g1a4sp-644113fa@ssh.runpod.io",
    "7x5748modmg2f3-644115a2@ssh.runpod.io",
    "xg327rt8qpmwo3-644113f8@ssh.runpod.io",
    "vs9f684j5042d5-64411d0b@ssh.runpod.io",
    "sa1icdeau5ywlu-64411168@ssh.runpod.io",
    "vu2zhgn2hijdj5-64411a83@ssh.runpod.io",
    "vto28fghfjs7yk-644111a7@ssh.runpod.io",
    "9mog923gn90y3n-64411a80@ssh.runpod.io",
    "2cuad68erwvhnn-64411658@ssh.runpod.io",
    "zypwv9xnnenri3-644114fc@ssh.runpod.io",
    "vln5dd1jcbmkoy-644114ee@ssh.runpod.io",
    "zja6wyakypx640-64411319@ssh.runpod.io",
    "f9kqz9wgppnilx-64410cd3@ssh.runpod.io",
    "i2ekvbxnye0x28-64411dfa@ssh.runpod.io",
    "0zvk77lftdby22-64411d1a@ssh.runpod.io",
    "5rwp58a61hrj57-644115fb@ssh.runpod.io",
    "mqcgyjx91ui6ez-6441150c@ssh.runpod.io",
    "wgt3avzsjzpprn-64410f7f@ssh.runpod.io",
    "4jojhvk8ukhlfh-64411578@ssh.runpod.io",
    "7glb3kk2yd5dql-64410af7@ssh.runpod.io",
    "8p3k7l4o7i9tnc-644114b9@ssh.runpod.io",
    "wz3zlu9e11hfnp-64411de4@ssh.runpod.io",
    "yfl5i3d6ficckr-64410e9f@ssh.runpod.io",
    "zq6rd289g707fq-6441110a@ssh.runpod.io",
    "b1lflq6cif114j-64411224@ssh.runpod.io",
    "nry3s9wucohi8r-64411899@ssh.runpod.io",
    "weqxpsbdhm00m8-64411a2d@ssh.runpod.io",
    "iwy0pudocqwa42-6441157c@ssh.runpod.io",
    "8441o3vs0ibyc9-64411164@ssh.runpod.io",
    "aurffkg8j2g8w8-644115a3@ssh.runpod.io",
    "mdfkjwtg1yp902-644114fe@ssh.runpod.io",
    "1aveqdi6v6mtst-64410ede@ssh.runpod.io",
    "avlngh41rqq1h0-64411121@ssh.runpod.io",
    "jw7z8meqjrmedb-644114eb@ssh.runpod.io",
    "85zwgaoj5ali82-64411a77@ssh.runpod.io",
    "jyd0mqpmi51bh5-64411c8a@ssh.runpod.io",
    "uodfgetkzexl98-64411def@ssh.runpod.io",
    "ne8lc7po2ydhpv-64411896@ssh.runpod.io",
    "dox2fb765imc9z-64411568@ssh.runpod.io",
    "hodx04rwzg73lc-64411173@ssh.runpod.io",
    "677rgz953t4l1h-64410e4a@ssh.runpod.io",
    "xggy1ebgwh0qdh-644110a4@ssh.runpod.io",
    "4v5d0fodmmitk5-64410efb@ssh.runpod.io",
    "fn39qpuvyp67aq-64410e80@ssh.runpod.io",
    "lr7w207b6pw5vz-6441146f@ssh.runpod.io",
    "gr2en0oc51gkff-64410b32@ssh.runpod.io",
    "sfnpkkeai71afi-6441166a@ssh.runpod.io",
    "3vbxgbq8ieqful-64411de9@ssh.runpod.io",
    "prirrjsbappngx-6441174d@ssh.runpod.io",
    "s6epii8matnhkh-64410f0d@ssh.runpod.io",
    "qbtgus1tkmf9cb-64411dc6@ssh.runpod.io",
    "d710x8ng8q50qk-64411418@ssh.runpod.io",
    "d44kxb0atvfwcp-64411df7@ssh.runpod.io",
    "hsfb10jlum784x-64410dec@ssh.runpod.io",
    "hkhtdgz5iswf8a-64411340@ssh.runpod.io",
    "nlw45ibt73zfpv-64411ded@ssh.runpod.io",
    "lygmnv8ytz65tr-644111ac@ssh.runpod.io",
    "50fin433pi7zd9-64411df7@ssh.runpod.io",
    "ftjulr5ooo7sdl-64411df1@ssh.runpod.io",
    "2r0gxlzv3fokfg-6441111c@ssh.runpod.io",
    "rfz63rz7no4pyt-64411df9@ssh.runpod.io",
    "5hhujcoudyhd1f-64411463@ssh.runpod.io",
    "un7clwdge5vz3n-64410af7@ssh.runpod.io",
    "8w8i8p7udowhay-64410e36@ssh.runpod.io"
]#   Latest index is 29



UPDATE_ALL = False
ACTIVE_HOSTS = [
    "38c15qumr609fy-64410ffb@ssh.runpod.io"
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
DEFAULT_WORKER_THREADS = 128
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

    channel.send(
    'if [ ! -f midnight_fetcher_bot_public/secure/mining-config.json ]; then '
    'mkdir -p midnight_fetcher_bot_public/secure && '
    'cat > midnight_fetcher_bot_public/secure/mining-config.json <<EOF\n'
    '{\n'
    f'  "addressOffset": 0,\n'
    f'  "workerThreads": {DEFAULT_WORKER_THREADS},\n'
    f'  "batchSize": {DEFAULT_BATCH_SIZE},\n'
    '  "wasMiningActive": true,\n'
    f'  "lastUpdated": "$(date -Iseconds)"\n'
    '}\n'
    'EOF\n'
    'fi\n'
    )
    stream_output(channel, timeout=1)

    channel.send(f"tmux send-keys -t {SESSION_NAME} C-c\n")
    channel.send(f"tmux send-keys -t {SESSION_NAME} C-c\n")
    stream_output(channel, timeout=1)

    channel.send(f'sed -i "s/\\"addressOffset\\":[ ]*[0-9]\\+/\\"addressOffset\\": {iteration}/" {"midnight_fetcher_bot_public/secure/mining-config.json"}\n')
    channel.send(f'sed -i "s/\\"workerThreads\\":[ ]*[0-9]\\+/\\"workerThreads\\": {DEFAULT_WORKER_THREADS}/" {"midnight_fetcher_bot_public/secure/mining-config.json"}\n')
    channel.send(f'sed -i "s/\\"batchSize\\":[ ]*[0-9]\\+/\\"batchSize\\": {DEFAULT_BATCH_SIZE}/" {"midnight_fetcher_bot_public/secure/mining-config.json"}\n')
    stream_output(channel, timeout=1)

    channel.send(SETUP_COMMAND + "\n")
    stream_output(channel, timeout=10)

    print(f"--- Finished with {host} ---\n")
    client.close()
    time.sleep(1)


def main():
    tasks = []
    iteration = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        for host in HOSTS:
            if UPDATE_ALL or host in ACTIVE_HOSTS:
                tasks.append(executor.submit(run_host, host, iteration))
            iteration += 1

        iteration = 0
        #for host in JOSH_HOSTS:
        #    tasks.append(executor.submit(run_host, host, iteration))
        #    iteration += 1

        for t in tasks:
            t.result()


if __name__ == "__main__":
    main()
