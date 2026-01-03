---
layout: post
title: How My Client Hit Linux Kernel Network Limits on AWS EKS
---

# The issue
This is a story about a tricky issue I resolved recently.

My client hosts their system on AWS EKS, and I manage their Kubernetes platform. One day, they sent me a ticket saying:

> We have recently noticed a lot of curl calls failing from our service that runs in the night time. Application tries to make curl call to application in another namespace via the service
>
> curl -v http://service-b-live.namespace-b:8080/api/mobile.html
But we are receiving intermittent curl failures.
This has started only recently from 7th Aug.
>
> Can we get someone to check if any DNS issues or issues with Load balancer happened around that time. 
It has been happening every night since 7th Aug 2025
>
> Considering it is a critical workflow for the application and we do not want any interruption in that, can these be looked on priority?
>
> Thank You

Here is the cURL output they provided:

> cURL error 65: The cURL request was retried 3 times and did not succeed. The most likely reason for the failure is that the cURL unable to rewind the body of the request and subsquent retries resulted in the same error. Turn on the debug option to see what went wrong.

# The investigation

## Start with the Log
According this cURL doc https://curl.se/libcurl/c/libcurl-errors.html , the 65 error code mean 

> CURLE_SEND_FAIL_REWIND (65)
>
> When doing a send operation curl had to rewind the data to retransmit, but the rewinding operation failed.

From my understanding, `cURL 65` is usually a side effect of something worse. Imagine the application is sending data, and suddenly something goes wrong with the network. The data stream is interrupted, and cURL tries to "rewind" to send it again, but fails.

I checked the ELK logs and found around 15,000 of these cURL 65 events. That is too many. This suggested a serious network issue, even though the connection was just Pod-to-Pod inside the cluster.

The client's application technically needs to run thousands of cURL commands because that is their business logic. Since there were so many requests, it was tricky to find the original error that triggered the rewind failure.

![cURL_logs](/images/post_1_curl_issue_kernel_out_of_quota/4.png)

## The Network Bandwidth

Next, I looked at the network metrics in ELK (collected by metricbeat).

![network_usage](/images/post_1_curl_issue_kernel_out_of_quota/1.png)

I could see their application consumed a lot of bandwidth, around `200 MB` to `230 MB` per 60 seconds.

I wondered: Did the network bandwidth of the EC2 instance (EKS worker nodes) exceed the limit?

I am using `t3a.2xlarge` instances as worker nodes. This type provides network bandwidth up to 5 Gbps, which is roughly `600 MB` per second. So, 200MB per 60 seconds is extremely small compared to the limit. Bandwidth was not the problem.

I tried to find if any other issues occurred at the same time. You know, network issues usually cause a chain reaction of other errors.

## The DNS Resolution

I started diving deeper into ELK and found these logs at `6th Aug 19:00 UTC`:

![php_dns_resolution_issue](/images/post_1_curl_issue_kernel_out_of_quota/2.png)

> SQLSTATE[HY000] [2002] php_network_getaddresses: getaddrinfo for sys.db.REDACTED.REDACTED.internal failed: Try again

It looked like the PHP code failed to resolve DNS. This suggested something might be wrong with the DNS service.

In Kubernetes, when a pod asks for DNS resolution, it sends the request to `coreDNS`. So I checked the `coreDNS` logs. I didn't see any obvious errors. The logs mostly looked like this:

> [INFO]10.234.170.252:55413 - 51380 "A IN sys.db.REDACTED.REDACTED.internal.cluster.local. udp 61 false 512" NXDOMAIN qr,aa,rd 154 0.0000050782s
>
> [INFO]10.234.170.252:55413 - 51380 "AAAA IN sys.db.REDACTED.REDACTED.internal.cluster.local. udp 61 false 512" NXDOMAIN qr,aa,rd 154 0.0000089841s
>
> [INFO]10.234.170.252:40561 - 17825 "AAAA IN sys.db.REDACTED.REDACTED.internal. udp 61 false 512" NOERROR qr,aa,rd 154 0.0000045891s
>
> [INFO]10.234.170.252:40561 - 17429 "AAAA IN sys.db.REDACTED.REDACTED.internal. udp 61 false 512" NOERROR qr,aa,rd 154 0.0000068391s

This is actually normal behavior.

1. `coreDNS` first tries to append cluster.local as a suffix. The record didn't exist, so it returned NXDOMAIN (Non-Existent Domain).

2. Then, `coreDNS` tried the original domain name without the suffix. It found the record and returned NOERROR.

My General Manager and a colleague saw NXDOMAIN and thought it was the root cause. They didn't know about this specific behavior in Kubernetes, so I had to explain it to them. I'm writing it here to remind myself too!

The `coreDNS` exposes metrics via this config:
```
prometheus 0.0.0.0:9153
```

But this is only for Prometheus.

Also, AWS EC2 instances have limits not just on bandwidth, but also on Connections and Packets Per Second (PPS).

https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/monitoring-network-performance-ena.html

Metricbeat struggles to collect these specific EC2 network metrics. So, I decided it was time to implement Prometheus with node-exporter.

Off-topic note: Why didn't I have Prometheus from the start? My client thought Metricbeat + ELK was enough. But in my opinion, Prometheus is much better for the Kubernetes world. Now was the perfect time to prove it.

## Install Prometheus Stack

I used the `kube-prometheus-stack` Helm chart and managed the deployment via `ArgoCD`.

I customized values.yaml to enable `kubelet`, `coreDNS`, and `nodeExporter` metrics:

```yaml
kubelet:
    enabled: true
    serviceMonitor:
        enabled: true
coreDns: # collect the coreDNS metrics
    enabled: true
    serviceMonitor:
        enabled: true
nodeExporter:
    enabled: true
prometheus-node-exporter:
    extraArgs:
        # These configurations below are important, they instruc the node export to collect metrics for PPS and Connections
        - --collector.filesystem.mount-points-exclude=^/(dev|proc|sys|var/lib/docker/.+|var/lib/kubelet/.+)($|/)
        - --collector.filesystem.fs-types-exclude=^(autofs|binfmt_misc|bpf|cgroup2?|configfs|debugfs|devpts|devtmpfs|fusectl|hugetlbfs|iso9660|mqueue|nsfs|overlay|proc|procfs|pstore|rpc_pipefs|securityfs|selinuxfs|squashfs|sysfs|tracefs)$
        - --collector.ethtool
        - --collector.ethtool.metrics-include=(bw_.*|pps_allowance_exceeded|linklocal_allowance_exceeded|conntrack_.*)

```

## Investigate with Prometheus metrics

Now I had the data I needed.

First, I checked `coreDNS` again. The PHP DNS issue happened at `6th Aug 19:00 UTC`.

![coreDNS_metrics](/images/post_1_curl_issue_kernel_out_of_quota/3.png)

I queried for all return codes (rcode) other than NOERROR. I only saw `NXDOMAIN`. There was no `SERVFAIL` or `REFUSED`. This confirmed coreDNS was healthy.

So, `coreDNS` was fine, but the PHP app still failed to resolve DNS. This suggested something was blocking the traffic from the App to coreDNS.

Time to check the AWS Network Interface metrics:

| Metric | Description | Supported on |
|--------|-------------|--------------|
| `bw_in_allowance_exceeded` | The number of packets queued or dropped because the inbound aggregate bandwidth exceeded the maximum for the instance. | All instance types |
| `bw_out_allowance_exceeded` | The number of packets queued or dropped because the outbound aggregate bandwidth exceeded the maximum for the instance. | All instance types |
| `conntrack_allowance_exceeded` | The number of packets dropped because connection tracking exceeded the maximum for the instance and new connections could not be established. This can result in packet loss for traffic to or from the instance. | All instance types |
| `conntrack_allowance_available` | The number of tracked connections that can be established by the instance before hitting the Connections Tracked allowance of that instance type. | Nitro-based instances only |
| `linklocal_allowance_exceeded` | The number of packets dropped because the PPS of the traffic to local proxy services exceeded the maximum for the network interface. This impacts traffic to the Amazon DNS service, the Instance Metadata Service, and the Amazon Time Sync Service, but does not impact traffic to custom DNS resolvers. | All instance types |
| `pps_allowance_exceeded` | The number of packets queued or dropped because the bidirectional PPS exceeded the maximum for the instance. | All instance types |

And after check, I surprise that only the `pps_allowance_exceeded` has data 

![pps_metrics](/images/post_1_curl_issue_kernel_out_of_quota/6.png)

Although the metric show that there were some dropped packets but not too much, they could not cause 15.000 `cURL 65` error. 
For the other metrics, all of them look good, nothing was dropped. 

Once again, this drive me to blocked route. 

If the network limit is not the root cause what could be?

## The CPU

Could the worker node be overloaded? If the CPU is overloaded, it increases latency. Processes have to wait longer for CPU time, which leads to network timeouts.

I checked the CPU Utilization of the worker nodes:

![cpu_utilization](/images/post_1_curl_issue_kernel_out_of_quota/10.png)

It was only around 60%. Not full. I also checked `Load Average`, and it looked fine (I forgot to take a screenshot of that, sorry!).

But while looking at CPU metrics, I noticed this:

![cpu_squeeze](/images/post_1_curl_issue_kernel_out_of_quota/9.png)

The `CPU Softnet Times Squeezed` was high, around 60 to 150 per second.

What does `CPU Softnet Times Squeezed` mean?
https://www.netdata.cloud/blog/understanding-interrupts-softirqs-and-softnet-in-linux/

> **Squeezed:** This dimension shows the number of times the network device budget was consumed or the time limit was reached, but more work was available. The network device budget is a resource that is allocated to the softnet code to process incoming packets. When the budget is consumed or the time limit is reached, the softnet code may not be able to process all of the available packets. In this case, the softnet code will “squeeze” the remaining packets into the next budget or time slice. If you are seeing a high number of squeezed packets, it may indicate that your network interface is not keeping up with the workload and needs to be optimized.

This made sense! As I mentioned, the application was sending thousands of requests in a very short time (likely more than 20k requests).

The Linux kernel has a specific limit on how many packets it will process in a single "poll cycle". Here are the common default values in most Linux distros:

```bash
net.core.netdev_budget = 300 # Max packets processed in one poll cycle
net.core.netdev_budget_usecs = 2000 # Time Budget to handle the packets, default 2 miliseconds
net.core.netdev_max_backlog = 1000 # Max packets queued if the kernel can't keep up.
```

If the kernel hits the `netdev_budget` limit before clearing the queue, it stops processing and increments the "squeezed" counter. The remaining packets have to wait, causing delays and timeouts.

This was the root cause.

# The Solution

I needed to increase these limits. I created a new file in `/etc/sysctl.d/` on the worker nodes:

```bash
sudo nano /etc/sysctl.d/99-network-tuning.conf
```
And added these configurations:
```bash
net.core.netdev_budget = 600
net.core.netdev_budget_usecs = 4000
net.core.netdev_max_backlog = 2000
```

Since we are on AWS EKS, I couldn't just SSH in and change it manually (because nodes are ephemeral). I updated the Launch Template for the Worker Node Auto Scaling Group. I added a small script in the `user-data` section to apply these kernel settings on boot.

After the update, the squeezed metric dropped, and the cURL errors disappeared. The issue was finally resolved.

