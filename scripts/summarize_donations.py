#!/usr/bin/env python3
"""
Summarize all successful donation consolidations from donation logs.

This script reads all donation log files and creates a summary of successful
consolidations, grouped by destination address, with total solutions consolidated
and estimated NIGHT tokens.
"""

import json
import os
import sys
from pathlib import Path
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from typing import Dict, List, Tuple, Optional
import argparse


def find_donation_directory() -> Optional[Path]:
    """Find the donation log directory, checking both possible locations."""
    # Check old location (installation folder)
    old_storage = Path.cwd() / 'storage'
    old_receipts = old_storage / 'receipts.jsonl'
    
    if old_receipts.exists():
        donation_dir = old_storage / 'donations'
        if donation_dir.exists():
            return donation_dir
    
    # Check new location (Documents folder)
    home = Path.home()
    if sys.platform == 'win32':
        documents = home / 'Documents'
    else:
        documents = home / 'Documents'
    
    new_storage = documents / 'MidnightFetcherBot' / 'storage'
    donation_dir = new_storage / 'donations'
    
    if donation_dir.exists():
        return donation_dir
    
    return None


def parse_donation_file(file_path: Path) -> List[Dict]:
    """Parse a single donation log file and return all records."""
    records = []
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                    records.append(record)
                except json.JSONDecodeError as e:
                    print(f"Warning: Failed to parse line {line_num} in {file_path.name}: {e}", file=sys.stderr)
    except Exception as e:
        print(f"Error reading {file_path}: {e}", file=sys.stderr)
    return records


def process_file(file_path: Path) -> Tuple[str, List[Dict]]:
    """Process a single file and return its path and records."""
    return (str(file_path), parse_donation_file(file_path))


def summarize_donations(donation_dir: Path, num_workers: int = 4) -> Dict:
    """Read all donation logs and create a summary of successful consolidations."""
    # Find all .jsonl files
    log_files = list(donation_dir.glob('*.jsonl'))
    
    if not log_files:
        print(f"No donation log files found in {donation_dir}")
        return {}
    
    print(f"Found {len(log_files)} donation log file(s)")
    
    # Process files in parallel if there are many, otherwise sequentially
    all_records = []
    
    if len(log_files) > 10 and num_workers > 1:
        print(f"Processing {len(log_files)} files with {num_workers} workers...")
        with ProcessPoolExecutor(max_workers=num_workers) as executor:
            futures = {executor.submit(process_file, f): f for f in log_files}
            for future in as_completed(futures):
                file_path, records = future.result()
                all_records.extend(records)
                print(f"Processed {Path(file_path).name}: {len(records)} records")
    else:
        print(f"Processing {len(log_files)} files sequentially...")
        for log_file in log_files:
            records = parse_donation_file(log_file)
            all_records.extend(records)
            print(f"Processed {log_file.name}: {len(records)} records")
    
    print(f"\nTotal records loaded: {len(all_records)}")
    
    # Filter for successful donations only
    successful = [r for r in all_records if r.get('success', False)]
    print(f"Successful donations: {len(successful)}")
    
    # Group by destination address
    summary = defaultdict(lambda: {
        'total_solutions': 0,
        'total_donations': 0,
        'source_addresses': set(),
        'first_donation': None,
        'last_donation': None,
        'donation_ids': set(),
    })
    
    for record in successful:
        dest = record.get('destinationAddress', 'unknown')
        response = record.get('response', {})
        
        # Extract solutions_consolidated from response
        solutions = 0
        if isinstance(response, dict):
            solutions = response.get('solutions_consolidated', 0)
        elif isinstance(response, str):
            try:
                response_dict = json.loads(response)
                solutions = response_dict.get('solutions_consolidated', 0)
            except:
                pass
        
        summary[dest]['total_solutions'] += solutions
        summary[dest]['total_donations'] += 1
        summary[dest]['source_addresses'].add(record.get('sourceAddress', 'unknown'))
        
        # Track donation IDs to avoid double counting
        donation_id = None
        if isinstance(response, dict):
            donation_id = response.get('donation_id')
        elif isinstance(response, str):
            try:
                response_dict = json.loads(response)
                donation_id = response_dict.get('donation_id')
            except:
                pass
        
        if donation_id:
            summary[dest]['donation_ids'].add(donation_id)
        
        # Track timestamps
        timestamp = record.get('timestamp', '')
        if timestamp:
            if not summary[dest]['first_donation'] or timestamp < summary[dest]['first_donation']:
                summary[dest]['first_donation'] = timestamp
            if not summary[dest]['last_donation'] or timestamp > summary[dest]['last_donation']:
                summary[dest]['last_donation'] = timestamp
    
    # Convert sets to counts and prepare final summary
    final_summary = {}
    total_solutions = 0
    total_estimated_night = 0
    
    for dest, data in summary.items():
        final_summary[dest] = {
            'destination_address': dest,
            'total_solutions_consolidated': data['total_solutions'],
            'total_donations': data['total_donations'],
            'unique_source_addresses': len(data['source_addresses']),
            'unique_donation_ids': len(data['donation_ids']),
            'first_donation': data['first_donation'],
            'last_donation': data['last_donation'],
        }
        total_solutions += data['total_solutions']
        total_estimated_night += data['total_solutions'] * 2  # 2 NIGHT per solution
    
    return {
        'summary_by_destination': final_summary,
        'totals': {
            'total_destinations': len(final_summary),
            'total_solutions_consolidated': total_solutions,
            'total_estimated_night': total_estimated_night,
            'total_successful_donations': len(successful),
        }
    }


def print_summary(summary: Dict):
    """Print a formatted summary to console."""
    totals = summary.get('totals', {})
    by_dest = summary.get('summary_by_destination', {})
    
    print("\n" + "="*80)
    print("DONATION CONSOLIDATION SUMMARY")
    print("="*80)
    print(f"\nTotal Destinations: {totals.get('total_destinations', 0)}")
    print(f"Total Successful Donations: {totals.get('total_successful_donations', 0)}")
    print(f"Total Solutions Consolidated: {totals.get('total_solutions_consolidated', 0):,}")
    print(f"Estimated NIGHT Consolidated: {totals.get('total_estimated_night', 0):,}")
    print("\n" + "-"*80)
    
    # Sort by solutions consolidated (descending)
    sorted_destinations = sorted(
        by_dest.items(),
        key=lambda x: x[1]['total_solutions_consolidated'],
        reverse=True
    )
    
    print("\nSummary by Destination Address:")
    print("-"*80)
    
    for dest, data in sorted_destinations:
        print(f"\nDestination: {dest}")
        print(f"  Solutions Consolidated: {data['total_solutions_consolidated']:,}")
        print(f"  Estimated NIGHT: {data['total_solutions_consolidated'] * 2:,}")
        print(f"  Total Donations: {data['total_donations']}")
        print(f"  Unique Source Addresses: {data['unique_source_addresses']}")
        print(f"  Unique Donation IDs: {data['unique_donation_ids']}")
        if data['first_donation']:
            print(f"  First Donation: {data['first_donation']}")
        if data['last_donation']:
            print(f"  Last Donation: {data['last_donation']}")
    
    print("\n" + "="*80)


def main():
    parser = argparse.ArgumentParser(
        description='Summarize successful donation consolidations from log files'
    )
    parser.add_argument(
        '--output',
        '-o',
        type=str,
        help='Output JSON file path (optional)'
    )
    parser.add_argument(
        '--workers',
        '-w',
        type=int,
        default=4,
        help='Number of parallel workers (default: 4)'
    )
    parser.add_argument(
        '--directory',
        '-d',
        type=str,
        help='Custom donation log directory path (optional)'
    )
    
    args = parser.parse_args()
    
    # Find donation directory
    if args.directory:
        donation_dir = Path(args.directory)
        if not donation_dir.exists():
            print(f"Error: Directory not found: {donation_dir}", file=sys.stderr)
            sys.exit(1)
    else:
        donation_dir = find_donation_directory()
        if not donation_dir:
            print("Error: Could not find donation log directory.", file=sys.stderr)
            print("Checked locations:", file=sys.stderr)
            print(f"  - {Path.cwd() / 'storage' / 'donations'}", file=sys.stderr)
            print(f"  - {Path.home() / 'Documents' / 'MidnightFetcherBot' / 'storage' / 'donations'}", file=sys.stderr)
            sys.exit(1)
    
    print(f"Using donation directory: {donation_dir}")
    
    # Generate summary
    summary = summarize_donations(donation_dir, num_workers=args.workers)
    
    if not summary:
        print("No donation data found.")
        sys.exit(0)
    
    # Print to console
    print_summary(summary)
    
    # Save to file if requested
    if args.output:
        output_path = Path(args.output)
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(summary, f, indent=2)
        print(f"\nSummary saved to: {output_path}")


if __name__ == '__main__':
    main()

