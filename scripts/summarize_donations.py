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
from datetime import datetime
import argparse


def find_storage_directories() -> Tuple[Optional[Path], Optional[Path]]:
    """
    Find the storage directory and donations subdirectory, checking all possible locations.
    Returns: (storage_dir, donations_dir)
    """
    # Check old location (installation folder)
    old_storage = Path.cwd() / 'storage'
    old_receipts = old_storage / 'receipts.jsonl'
    
    if old_receipts.exists():
        donation_dir = old_storage / 'donations'
        if donation_dir.exists():
            return old_storage, donation_dir
    
    # Check new location (Documents folder)
    home = Path.home()
    documents = home / 'Documents'
    
    new_storage = documents / 'MidnightFetcherBot' / 'storage'
    donation_dir = new_storage / 'donations'
    
    if donation_dir.exists():
        return new_storage, donation_dir
    
    # Check fallback location (if USERPROFILE/HOME don't exist, uses process.cwd())
    # This would be: process.cwd()/Documents/MidnightFetcherBot/storage
    fallback_storage = Path.cwd() / 'Documents' / 'MidnightFetcherBot' / 'storage'
    fallback_donations = fallback_storage / 'donations'
    
    if fallback_donations.exists():
        return fallback_storage, fallback_donations
    
    return None, None


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


def parse_consolidation_file(file_path: Path) -> List[Dict]:
    """Parse consolidation.jsonl file and convert to donation record format."""
    records = []
    skipped = 0
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    consolidation = json.loads(line)
                    # Convert consolidation record to donation record format
                    # Include both success and "already donated" cases (status: 'success')
                    if consolidation.get('status') == 'success':
                        record = {
                            'timestamp': consolidation.get('ts', ''),
                            'sourceAddress': consolidation.get('sourceAddress', ''),
                            'sourceAddressIndex': consolidation.get('sourceIndex'),
                            'destinationAddress': consolidation.get('destinationAddress', ''),
                            'success': True,  # Mark as success for filtering
                            'response': {
                                'solutions_consolidated': consolidation.get('solutionsConsolidated', 0),
                                'message': consolidation.get('message', ''),
                            },
                            '_source': 'consolidations.jsonl',  # Track source for debugging
                        }
                        records.append(record)
                    else:
                        skipped += 1
                except json.JSONDecodeError as e:
                    print(f"Warning: Failed to parse line {line_num} in {file_path.name}: {e}", file=sys.stderr)
    except Exception as e:
        print(f"Error reading {file_path}: {e}", file=sys.stderr)
    if skipped > 0:
        print(f"  (Skipped {skipped} failed consolidation records)")
    return records


def process_file(file_path: Path) -> Tuple[str, List[Dict]]:
    """Process a single file and return its path and records."""
    return (str(file_path), parse_donation_file(file_path))


def summarize_donations(donation_dir: Path, storage_dir: Path, num_workers: int = 4, verbose: bool = False, show_failed: bool = False) -> Dict:
    """Read all donation logs and create a summary of successful consolidations."""
    all_records = []
    
    # Find all .jsonl files in donations directory
    log_files = list(donation_dir.glob('*.jsonl'))
    
    if log_files:
        print(f"Found {len(log_files)} donation log file(s) in {donation_dir}")
        
        # Process files in parallel if there are many, otherwise sequentially
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
    
    # Also check for consolidations.jsonl file
    consolidation_file = storage_dir / 'consolidations.jsonl'
    if consolidation_file.exists():
        print(f"\nFound consolidation log file: {consolidation_file}")
        consolidation_records = parse_consolidation_file(consolidation_file)
        all_records.extend(consolidation_records)
        print(f"Loaded {len(consolidation_records)} records from consolidations.jsonl")
    
    if not all_records:
        print(f"No donation records found in {donation_dir} or {consolidation_file}")
        return {}
    
    print(f"\nTotal records loaded: {len(all_records)}")
    
    # Debug: Show breakdown by source
    donation_records = [r for r in all_records if r.get('_source') != 'consolidations.jsonl']
    consolidation_records = [r for r in all_records if r.get('_source') == 'consolidations.jsonl']
    if verbose or donation_records or consolidation_records:
        if donation_records:
            print(f"  From donation logs: {len(donation_records)}")
        if consolidation_records:
            print(f"  From consolidations.jsonl: {len(consolidation_records)}")
    
    # Categorize donations: successful, already_submitted, failed
    successful = []
    already_submitted = []
    failed = []
    
    for r in all_records:
        # Check for "already donated" / "already submitted" cases
        error_msg = (r.get('error') or '').lower()
        response = r.get('response', {})
        response_msg = ''
        if isinstance(response, dict):
            response_msg = (response.get('message') or '').lower()
        elif isinstance(response, str):
            try:
                response_dict = json.loads(response)
                response_msg = (response_dict.get('message') or '').lower()
            except:
                pass
        
        # Check if it's marked as alreadyDonated or has "already" in message
        is_already = (
            r.get('alreadyDonated') is True or
            'already' in error_msg or
            'already' in response_msg or
            (isinstance(response, dict) and response.get('alreadyDonated') is True)
        )
        
        # Check success field (donation logs)
        if r.get('success') is True:
            # Even if successful, check if it's an "already donated" case (0 solutions)
            if is_already or (isinstance(response, dict) and response.get('solutions_consolidated', 0) == 0 and 'already' in response_msg):
                already_submitted.append(r)
            else:
                successful.append(r)
        # Check status field (consolidation logs)
        elif r.get('status') == 'success':
            # Consolidation logs with 0 solutions are "already donated" cases
            if isinstance(response, dict) and response.get('solutions_consolidated', 0) == 0:
                already_submitted.append(r)
            else:
                successful.append(r)
        else:
            # Failed donations
            if is_already:
                # Some failures might be "already donated" errors
                already_submitted.append(r)
            else:
                failed.append(r)
    
    print(f"Successful donations: {len(successful)}")
    print(f"Already submitted (0 solutions): {len(already_submitted)}")
    if failed:
        print(f"Failed donations: {len(failed)}")
    
    # Debug: Show sample of what we're processing
    if verbose and successful:
        print(f"\nSample successful record structure:")
        sample = successful[0]
        print(f"  Keys: {list(sample.keys())}")
        print(f"  Has 'success': {'success' in sample}")
        print(f"  Has 'status': {'status' in sample}")
        print(f"  Destination: {sample.get('destinationAddress', 'N/A')[:50]}...")
        print(f"  Source: {sample.get('sourceAddress', 'N/A')[:50]}...")
        response = sample.get('response', {})
        if isinstance(response, dict):
            print(f"  Solutions: {response.get('solutions_consolidated', 'N/A')}")
        else:
            print(f"  Response type: {type(response)}")
    
    # Deduplicate: If same source->dest appears in both donation logs and consolidations.jsonl,
    # prefer the one with more information (solutions > 0, or has donation_id)
    if donation_records and consolidation_records:
        # Create a deduplication key: (source, dest, timestamp within 1 second)
        seen_keys = set()
        deduplicated = []
        duplicates_found = 0
        
        # Sort by solutions (descending) so we keep the best record
        all_sorted = sorted(successful, key=lambda r: (
            -1 if isinstance(r.get('response'), dict) and r.get('response', {}).get('solutions_consolidated', 0) > 0 else 0,
            r.get('timestamp', '') or r.get('ts', '')
        ), reverse=True)
        
        for record in all_sorted:
            source = record.get('sourceAddress', '')
            dest = record.get('destinationAddress', '')
            timestamp = record.get('timestamp', '') or record.get('ts', '')
            
            # Create a key that allows for small timestamp differences (same donation might be logged twice)
            # Use date + hour as the key to catch duplicates logged within the same hour
            if timestamp:
                try:
                    dt = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
                    time_key = f"{source}|{dest}|{dt.date()}|{dt.hour}"
                except:
                    time_key = f"{source}|{dest}|{timestamp[:13]}"  # First 13 chars (YYYY-MM-DDTHH)
            else:
                time_key = f"{source}|{dest}|unknown"
            
            if time_key not in seen_keys:
                seen_keys.add(time_key)
                deduplicated.append(record)
            else:
                duplicates_found += 1
                if verbose:
                    print(f"  Deduplicated: {source[:30]}... -> {dest[:30]}... (timestamp: {timestamp[:19]})")
        
        if duplicates_found > 0:
            print(f"Deduplicated {duplicates_found} duplicate records (same source->dest within same hour)")
            successful = deduplicated
            print(f"Unique successful donations after deduplication: {len(successful)}")
    
    # Group by destination address
    summary = defaultdict(lambda: {
        'total_solutions': 0,
        'total_donations': 0,
        'already_submitted': 0,
        'failed': 0,
        'source_addresses': set(),
        'first_donation': None,
        'last_donation': None,
        'donation_ids': set(),
    })
    
    # Also track totals for already_submitted and failed
    already_submitted_by_dest = defaultdict(lambda: {
        'count': 0,
        'source_addresses': set(),
    })
    failed_by_dest = defaultdict(lambda: {
        'count': 0,
        'source_addresses': set(),
        'errors': [],
    })
    
    # Process already_submitted records
    for record in already_submitted:
        dest = record.get('destinationAddress', 'unknown')
        if dest == 'unknown':
            continue
        source_addr = record.get('sourceAddress', 'unknown')
        already_submitted_by_dest[dest]['count'] += 1
        already_submitted_by_dest[dest]['source_addresses'].add(source_addr)
    
    # Process failed records
    for record in failed:
        dest = record.get('destinationAddress', 'unknown')
        if dest == 'unknown':
            continue
        source_addr = record.get('sourceAddress', 'unknown')
        error_msg = record.get('error', 'Unknown error')
        failed_by_dest[dest]['count'] += 1
        failed_by_dest[dest]['source_addresses'].add(source_addr)
        if error_msg and error_msg not in failed_by_dest[dest]['errors']:
            failed_by_dest[dest]['errors'].append(error_msg)
    
    # Track all source addresses for debugging
    all_source_addresses = set()
    records_without_solutions = []
    
    for record in successful:
        dest = record.get('destinationAddress', 'unknown')
        if dest == 'unknown':
            print(f"Warning: Record missing destinationAddress: {record.get('sourceAddress', 'unknown')[:50]}...")
            continue
            
        source_addr = record.get('sourceAddress', 'unknown')
        all_source_addresses.add(source_addr)
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
                # Try to extract from string if it's a JSON string
                pass
        
        # Track records without solutions for debugging
        if solutions == 0:
            records_without_solutions.append({
                'source': source_addr[:50],
                'dest': dest[:50],
                'response_type': type(response).__name__,
                'has_response': response is not None and response != {},
            })
        
        summary[dest]['total_solutions'] += solutions
        summary[dest]['total_donations'] += 1
        summary[dest]['source_addresses'].add(source_addr)
        
        # Track donation IDs to avoid double counting (but don't skip records without IDs)
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
        timestamp = record.get('timestamp', '') or record.get('ts', '')
        if timestamp:
            if not summary[dest]['first_donation'] or timestamp < summary[dest]['first_donation']:
                summary[dest]['first_donation'] = timestamp
            if not summary[dest]['last_donation'] or timestamp > summary[dest]['last_donation']:
                summary[dest]['last_donation'] = timestamp
    
    # Debug output
    if verbose:
        print(f"\nUnique source addresses processed: {len(all_source_addresses)}")
        if records_without_solutions:
            print(f"Records with 0 solutions: {len(records_without_solutions)}")
            if len(records_without_solutions) <= 10:
                print("  (These are likely 'already donated' cases, which is normal)")
                for r in records_without_solutions:
                    print(f"    {r['source']}... -> {r['dest']}...")
            else:
                print(f"  (Showing first 10 of {len(records_without_solutions)} records with 0 solutions)")
                for r in records_without_solutions[:10]:
                    print(f"    {r['source']}... -> {r['dest']}...")
    
    # Convert sets to counts and prepare final summary
    final_summary = {}
    total_solutions = 0
    total_estimated_night = 0
    total_already_submitted = 0
    total_failed = 0
    
    # Get all unique destinations
    all_destinations = set(summary.keys()) | set(already_submitted_by_dest.keys()) | set(failed_by_dest.keys())
    
    for dest in all_destinations:
        data = summary.get(dest, {
            'total_solutions': 0,
            'total_donations': 0,
            'source_addresses': set(),
            'donation_ids': set(),
            'first_donation': None,
            'last_donation': None,
        })
        already_data = already_submitted_by_dest.get(dest, {'count': 0, 'source_addresses': set()})
        failed_data = failed_by_dest.get(dest, {'count': 0, 'source_addresses': set(), 'errors': []})
        
        final_summary[dest] = {
            'destination_address': dest,
            'total_solutions_consolidated': data['total_solutions'],
            'total_donations': data['total_donations'],
            'already_submitted': already_data['count'],
            'failed': failed_data['count'],
            'unique_source_addresses': len(data['source_addresses'] | already_data['source_addresses'] | failed_data['source_addresses']),
            'unique_donation_ids': len(data['donation_ids']),
            'first_donation': data['first_donation'],
            'last_donation': data['last_donation'],
        }
        total_solutions += data['total_solutions']
        total_estimated_night += data['total_solutions'] * 2  # 2 NIGHT per solution
        total_already_submitted += already_data['count']
        total_failed += failed_data['count']
    
    return {
        'summary_by_destination': final_summary,
        'totals': {
            'total_destinations': len(final_summary),
            'total_solutions_consolidated': total_solutions,
            'total_estimated_night': total_estimated_night,
            'total_successful_donations': len(successful),
            'total_already_submitted': total_already_submitted,
            'total_failed': total_failed,
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
    print(f"Total Already Submitted: {totals.get('total_already_submitted', 0)}")
    print(f"Total Failed: {totals.get('total_failed', 0)}")
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
        print(f"  Successful Donations: {data['total_donations']}")
        print(f"  Already Submitted: {data['already_submitted']}")
        print(f"  Failed: {data['failed']}")
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
    parser.add_argument(
        '--verbose',
        '-v',
        action='store_true',
        help='Show detailed debugging information'
    )
    parser.add_argument(
        '--show-failed',
        action='store_true',
        help='Include failed donations in output (for debugging)'
    )
    
    args = parser.parse_args()
    
    # Find storage and donation directories
    if args.directory:
        donation_dir = Path(args.directory)
        if not donation_dir.exists():
            print(f"Error: Directory not found: {donation_dir}", file=sys.stderr)
            sys.exit(1)
        # Try to find parent storage directory for consolidations.jsonl
        storage_dir = donation_dir.parent
    else:
        storage_dir, donation_dir = find_storage_directories()
        if not donation_dir:
            print("Error: Could not find donation log directory.", file=sys.stderr)
            print("Checked locations:", file=sys.stderr)
            print(f"  - {Path.cwd() / 'storage' / 'donations'}", file=sys.stderr)
            print(f"  - {Path.home() / 'Documents' / 'MidnightFetcherBot' / 'storage' / 'donations'}", file=sys.stderr)
            print(f"  - {Path.cwd() / 'Documents' / 'MidnightFetcherBot' / 'storage' / 'donations'}", file=sys.stderr)
            sys.exit(1)
    
    print(f"Using storage directory: {storage_dir}")
    print(f"Using donation directory: {donation_dir}")
    
    # Generate summary
    summary = summarize_donations(
        donation_dir, 
        storage_dir, 
        num_workers=args.workers,
        verbose=args.verbose,
        show_failed=args.show_failed
    )
    
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

