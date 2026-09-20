# EdgeRIC MCS Control muApp

This muApp allows dynamic MCS (Modulation and Coding Scheme) control for individual UEs. When an MCS override is set, the gNB scheduler will use the specified MCS instead of link adaptation.

## Overview

The muApp:
1. Receives per-TTI metrics from the RAN via ZMQ
2. Computes MCS values using configurable algorithms
3. Sends MCS override decisions back to the RAN with TTI information
4. The RAN applies overrides only if fresh (current_TTI - decision_TTI <= 2)
5. If the muApp stops sending, MCS reverts to link adaptation

## Requirements

### Python Packages

```bash
# From the project root, activate the shared virtual environment
source .venv/bin/activate
python -m pip install -r requirements.txt
```

### Protobuf Generation

```bash
cd edgeric/protobufs
protoc --python_out=.. *.proto
cd ../..
```

## Usage

```bash
cd edgeric/muapp-mcs

# Fixed MCS: Set MCS=20 for all UEs
python mcs_muapp.py --algorithm fixed --mcs 20

# Random MCS: Random MCS between 10-20 for each UE
python mcs_muapp.py --algorithm random

# Random MCS with custom range
python mcs_muapp.py --algorithm random --min-mcs 15 --max-mcs 25

# CQI-based MCS: Map CQI to MCS
python mcs_muapp.py --algorithm cqi

# Test staleness (MCS should be rejected)
python mcs_muapp.py --algorithm fixed --mcs 20 --tti-offset -3
```

## Available Algorithms

| Algorithm | Description |
|-----------|-------------|
| `fixed` | Same MCS for all UEs (use `--mcs` to specify) |
| `random` | Random MCS in range for each UE (use `--min-mcs`, `--max-mcs`) |
| `cqi` | Map CQI to MCS (higher CQI = higher MCS) |

## Files

| File | Description |
|------|-------------|
| `mcs_muapp.py` | Main MCS muApp with algorithms |
| `README.md` | This documentation |

## MCS Index Reference

| MCS Index | Modulation | Approx. Code Rate | Use Case |
|-----------|------------|-------------------|----------|
| 0-9       | QPSK       | Low               | Poor channel, cell edge |
| 10-16     | 16QAM      | Medium            | Average channel |
| 17-28     | 64QAM      | High              | Good channel, high throughput |

**Note:** MCS 27-28 typically require very good channel conditions (CQI 14-15).

## Staleness Checking

The RAN discards stale MCS decisions to ensure real-time control:

1. The muApp includes `tti_index` in its MCS message
2. The RAN checks: `current_TTI - received_TTI <= 2`
3. If stale, MCS override is discarded and link adaptation is used

### Testing Staleness

```bash
# Normal operation (MCS applied)
python mcs_controller.py --all --mcs 20 --tti-offset 0

# Simulate 3 TTI delay (MCS REJECTED, reverts to link adaptation)
python mcs_controller.py --all --mcs 20 --tti-offset -3
```

## How It Works

1. **Metrics Subscription**: The controller subscribes to `ipc:///tmp/metrics_data` to learn active UEs and current TTI.

2. **MCS Control**: MCS overrides are published to `ipc:///tmp/control_mcs` with per-UE (RNTI, MCS) pairs and TTI for staleness check.

3. **gNB Processing**: The gNB receives the control message in `get_mcs_from_er()`, checks staleness, and applies the MCS during scheduling.

## ZMQ Endpoints

| Direction | Address | Description |
|-----------|---------|-------------|
| Input (SUB) | `ipc:///tmp/metrics_data` | Per-TTI metrics from RAN |
| Output (PUB) | `ipc:///tmp/control_mcs` | MCS overrides to RAN |

## Protobuf Schema

```protobuf
message McsControl {
    uint32 ran_index = 1;           // RAN instance index
    uint32 tti_index = 2;           // TTI for staleness check
    repeated UeMcs ue_mcs = 3;      // Per-UE MCS indexed by RNTI
}

message UeMcs {
    uint32 rnti = 1;                // UE RNTI
    uint32 mcs = 2;                 // MCS index (0-28, or 255 for no override)
}
```

## Example: Comparing MCS Impact

```bash
# Terminal 1: Run collector to see metrics
python ../collector.py --quiet

# Terminal 2: Set low MCS (see throughput drop)
python mcs_controller.py --rnti 17921 --mcs 5

# Terminal 2: Set high MCS (see throughput increase)
python mcs_controller.py --rnti 17921 --mcs 28
```

## Limitations

- MCS override is for **DL only** (affects PDSCH scheduling)
- UL MCS is determined by gNB link adaptation based on PUSCH CRC/SNR
- Setting MCS too high for channel conditions will cause HARQ failures
- MCS value of 255 is used internally to mean "no override"
