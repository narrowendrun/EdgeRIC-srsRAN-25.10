# EdgeRIC Scheduling muApp

This muApp allows you to dynamically control the PRB allocation weights for UEs in real-time.

## Overview

The controller:
1. Receives per-TTI metrics from the RAN via ZMQ
2. Computes scheduling weights using configurable algorithms
3. Sends weight decisions back to the RAN with TTI information
4. The RAN applies weights only if fresh (current_TTI - decision_TTI <= 2)

## Requirements

### Python Packages

```bash
# From the project root, activate the shared virtual environment
source .venv/bin/activate
python -m pip install -r requirements.txt
```

### Required Packages

| Package | Version | Description |
|---------|---------|-------------|
| `pyzmq` | >= 25.0 | ZeroMQ Python bindings for IPC communication |
| `protobuf` | >= 4.0 | Protocol Buffers for message serialization |
| `redis` | >= 4.0 | Redis client for algorithm selection |
| `numpy` | >= 1.20 | Numerical operations |

### Protobuf Generation

Generate Python protobuf files before first use:

```bash
cd edgeric/protobufs
protoc --python_out=.. *.proto
cd ../..
```

This creates `metrics_pb2.py` and `control_weights_pb2.py` in the `edgeric/` directory.

## Weight Semantics

When you set `weight = 0.3` for a UE, it means that UE gets `0.3 * available_prbs` PRBs for that TTI.

- `weight = 0.0`: UE gets no allocation
- `weight = 0.5`: UE gets 50% of available PRBs
- `weight = 1.0`: UE gets 100% of available PRBs

**Multi-UE Example:** With 2 UEs and weights [0.7, 0.3]:
- UE1 gets 0.7 × 48 = 33 PRBs (capped by actual need)
- UE2 gets 0.3 × 48 = 14 PRBs (capped by actual need)

## Files

| File | Description |
|------|-------------|
| `scheduling_muapp.py` | Main muApp with Redis-controlled scheduling algorithms |
| `edgeric_messenger.py` | ZMQ interface for metrics/weights communication |
| `../protobufs/` | Protobuf definitions for RAN communication |

## Quick Start

```bash
# 1. From the project root, activate the shared virtual environment
source .venv/bin/activate

# 2. Generate protobufs (if needed)
cd edgeric/protobufs
protoc --python_out=.. *.proto
cd ../muapp-scheduling

# 3. Start the scheduling muApp
python scheduling_muapp.py

# 4. Set algorithm via Redis (in another terminal)
redis-cli SET scheduling_algorithm "Max CQI"
```

## Usage

### With Redis Algorithm Selection

```bash
# Start muApp (reads algorithm from Redis)
python scheduling_muapp.py

# Set algorithm via Redis
redis-cli SET scheduling_algorithm "Fixed Weight"
redis-cli SET scheduling_algorithm "Max CQI"
redis-cli SET scheduling_algorithm "Max Weight"
redis-cli SET scheduling_algorithm "Proportional Fair"
redis-cli SET scheduling_algorithm "Round Robin"
```

### With Fixed Algorithm (No Redis)

```bash
python scheduling_muapp.py --algorithm "Max CQI"
python scheduling_muapp.py --algorithm "Proportional Fair"
```

## Available Algorithms

| Algorithm | Description |
|-----------|-------------|
| `Fixed Weight` | Static weights (edit `fixed_weights()` function) |
| `Max CQI` | Prioritize UE with best channel quality |
| `Max Weight` | CQI × Backlog weighted scheduling |
| `Proportional Fair` | Rate-proportional fairness |
| `Round Robin` | Time-based round robin |

## Customizing Fixed Weights

Edit `scheduling_muapp.py`, function `fixed_weights()`:

```python
def fixed_weights():
    # ...
    for i in range(numues):
        weights[i*2+0] = RNTIs[i]
        # Customize weights here:
        if i == 0:
            weights[i*2+1] = 0.3  # First UE: 30%
        elif i == 1:
            weights[i*2+1] = 0.7  # Second UE: 70%
        else:
            weights[i*2+1] = 1.0 / numues
    return weights
```

## Using edgeric_messenger.py in Your Own Code

```python
from edgeric_messenger import (
    get_metrics_multi,
    get_tti_index,
    send_scheduling_weight,
    cleanup
)

# Get metrics for all active UEs
ue_data = get_metrics_multi()
for rnti, metrics in ue_data.items():
    print(f"UE {rnti}: CQI={metrics['CQI']}, Backlog={metrics['Backlog']}")

# Get current TTI
tti = get_tti_index()

# Send weights: [RNTI1, weight1, RNTI2, weight2, ...]
weights = [17921, 0.3, 17922, 0.7]
send_scheduling_weight(weights, include_tti=True)

# Test staleness (simulate old message)
send_scheduling_weight(weights, include_tti=True, tti_offset=-3)

# Cleanup when done
cleanup()
```

### API Reference

| Function | Description |
|----------|-------------|
| `get_metrics_multi()` | Returns dict of {RNTI: metrics} for all active UEs |
| `get_tti_index()` | Returns current TTI from last received metrics |
| `send_scheduling_weight(weights, include_tti, verbose, tti_offset)` | Send weights to RAN |
| `cleanup()` | Close ZMQ sockets |

### send_scheduling_weight Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `weights` | list/array | required | `[RNTI1, w1, RNTI2, w2, ...]` |
| `include_tti` | bool | `True` | Include TTI for staleness check |
| `verbose` | bool | `False` | Print every message sent |
| `tti_offset` | int | `0` | Offset to apply to TTI (for testing) |

## Metrics Available

| Field | Description |
|-------|-------------|
| `CQI` | Channel Quality Indicator (0-15) |
| `SNR` | Signal-to-Noise Ratio in dB |
| `Backlog` | DL buffer pending bytes |
| `Tx_brate` | DL bytes scheduled this TTI |
| `UL_buffer` | UL pending bytes |
| `dl_prbs` | DL PRBs allocated |
| `dl_mcs` | DL MCS index |

## Staleness Checking

The RAN discards stale weight decisions to ensure real-time control:

1. The muApp includes `tti_index` in its weight message
2. The RAN checks: `current_TTI - received_TTI <= 2`
3. If the difference exceeds the threshold, weights are discarded and default scheduling is used

This ensures the muApp must respond within 2-3ms (1 TTI = 1ms).

### Testing Staleness

You can test the staleness mechanism using `tti_offset`:

```python
from edgeric_messenger import send_scheduling_weight

# Normal operation (weights applied)
send_scheduling_weight(weights, include_tti=True, tti_offset=0)

# Simulate 1 TTI delay (weights still applied, within threshold)
send_scheduling_weight(weights, include_tti=True, tti_offset=-1)

# Simulate 3 TTI delay (weights REJECTED, too stale)
send_scheduling_weight(weights, include_tti=True, tti_offset=-3)
```

When weights are rejected due to staleness:
- RAN falls back to default RAN scheduling
- All UEs get equal share of resources

## ZMQ Endpoints

| Direction | Address | Description |
|-----------|---------|-------------|
| Input (SUB) | `ipc:///tmp/metrics_data` | Per-TTI metrics from RAN |
| Output (PUB) | `ipc:///tmp/control_weights` | Scheduling weights to RAN |

## Protobuf Messages

The protobuf definitions are in `../protobufs/`:

### SchedulingWeights (sent to RAN)
```protobuf
message SchedulingWeights {
    uint32 ran_index = 1;
    uint32 tti_index = 2;        // For staleness check
    repeated UeWeight ue_weights = 3;
}

message UeWeight {
    uint32 rnti = 1;
    float weight = 2;            // 0.0 to 1.0
}
```

### TtiMetrics (received from RAN)
```protobuf
message TtiMetrics {
    uint32 tti_index = 1;         // TTI index (0-9999, rolls over)
    uint64 timestamp_us = 2;      // Unix timestamp in microseconds
    repeated UeMetrics ues = 3;   // Per-UE metrics
}
```

See `../protobufs/metrics.proto` for the full metrics schema.
