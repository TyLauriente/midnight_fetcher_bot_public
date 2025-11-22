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
from typing import Dict, List, Tuple, Optional, Set
from datetime import datetime
import argparse
import fnmatch


def search_for_donation_files(search_entire_system: bool = False, max_depth: int = 10) -> List[Tuple[Path, str]]:
    """
    Search for donation log files across the system.
    Returns: List of (file_path, location_type) tuples
    """
    found_files: List[Tuple[Path, str]] = []
    searched_paths: Set[str] = set()
    
    # Patterns to match
    donation_patterns = ['donation-*.jsonl', 'consolidations.jsonl']
    
    def should_skip_directory(dir_path: Path) -> bool:
        """Check if directory should be skipped during search."""
        dir_str = str(dir_path).lower()
        # Skip common system directories
        skip_patterns = [
            'node_modules',
            '.git',
            '.next',
            'target',
            '__pycache__',
            '.venv',
            'venv',
            'env',
            'windows\\system32',
            'windows\\syswow64',
            'program files',
            'program files (x86)',
            '$recycle.bin',
            'system volume information',
            'appdata\\local\\temp',
            'appdata\\local\\microsoft',
            'appdata\\roaming\\microsoft',
        ]
        return any(pattern in dir_str for pattern in skip_patterns)
    
    def search_directory(root: Path, max_depth: int, current_depth: int = 0) -> None:
        """Recursively search a directory for donation files."""
        if current_depth > max_depth:
            return
        
        root_str = str(root)
        if root_str in searched_paths:
            return
        searched_paths.add(root_str)
        
        try:
            if not root.exists() or not root.is_dir():
                return
            
            if should_skip_directory(root):
                return
            
            # Check for donation files in current directory
            for pattern in donation_patterns:
                for file_path in root.glob(pattern):
                    if file_path.is_file():
                        found_files.append((file_path, 'searched'))
            
            # Recurse into subdirectories
            if current_depth < max_depth:
                try:
                    for item in root.iterdir():
                        if item.is_dir() and not item.name.startswith('.'):
                            search_directory(item, max_depth, current_depth + 1)
                except (PermissionError, OSError):
                    pass  # Skip directories we can't access
        except (PermissionError, OSError, UnicodeDecodeError):
            pass  # Skip directories we can't access
    
    print("Searching for donation log files...")
    print("=" * 80)
    
    # First, check all known locations
    print("\n1. Checking known locations...")
    known_locations = [
        (Path.cwd() / 'storage' / 'donations', 'installation folder'),
        (Path.home() / 'Documents' / 'MidnightFetcherBot' / 'storage' / 'donations', 'Documents folder'),
        (Path.cwd() / 'Documents' / 'MidnightFetcherBot' / 'storage' / 'donations', 'fallback Documents'),
    ]
    
    if sys.platform == 'win32':
        userprofile = os.environ.get('USERPROFILE')
        if userprofile:
            known_locations.append((
                Path(userprofile) / 'Documents' / 'MidnightFetcherBot' / 'storage' / 'donations',
                'USERPROFILE Documents'
            ))
    
    for location, desc in known_locations:
        if location.exists():
            print(f"   Checking {desc}: {location}")
            for pattern in donation_patterns:
                for file_path in location.glob(pattern):
                    if file_path.is_file():
                        found_files.append((file_path, f'known: {desc}'))
            # Also check parent for consolidations.jsonl
            parent = location.parent
            consolidations_file = parent / 'consolidations.jsonl'
            if consolidations_file.exists():
                found_files.append((consolidations_file, f'known: {desc} (parent)'))
    
    if not search_entire_system:
        print("\n2. Searching common user directories...")
        common_dirs = [
            Path.home(),
            Path.home() / 'Documents',
            Path.home() / 'Desktop',
            Path.home() / 'Downloads',
        ]
        
        if sys.platform == 'win32':
            userprofile = os.environ.get('USERPROFILE', '')
            if userprofile:
                common_dirs.extend([
                    Path(userprofile) / 'Documents',
                    Path(userprofile) / 'Desktop',
                    Path(userprofile) / 'Downloads',
                ])
        
        for common_dir in common_dirs:
            if common_dir.exists():
                print(f"   Searching {common_dir}...")
                search_directory(common_dir, max_depth=5, current_depth=0)
    else:
        print("\n2. Searching entire system (this may take a while)...")
        print("   Warning: This will search all accessible directories. It may take several minutes.")
        
        # Start from common root directories
        search_roots = [Path.home()]
        
        if sys.platform == 'win32':
            # On Windows, search from user profile and common locations
            userprofile = os.environ.get('USERPROFILE', '')
            if userprofile:
                search_roots.append(Path(userprofile))
            # Also check C:\Users if accessible
            c_users = Path('C:/Users')
            if c_users.exists():
                search_roots.append(c_users)
        else:
            # On Unix, search from home directory
            search_roots.append(Path.home())
        
        for root in search_roots:
            if root.exists():
                print(f"   Searching from {root}...")
                search_directory(root, max_depth=max_depth, current_depth=0)
    
    # Remove duplicates (same file found multiple times)
    unique_files = {}
    for file_path, location_type in found_files:
        file_str = str(file_path)
        if file_str not in unique_files:
            unique_files[file_str] = (file_path, location_type)
        else:
            # Keep the more specific location type
            existing_type = unique_files[file_str][1]
            if 'known:' in location_type and 'known:' not in existing_type:
                unique_files[file_str] = (file_path, location_type)
    
    return list(unique_files.values())


def print_search_results(found_files: List[Tuple[Path, str]]) -> None:
    """Print the results of the file search."""
    if not found_files:
        print("\n" + "=" * 80)
        print("No donation log files found.")
        print("=" * 80)
        return
    
    print("\n" + "=" * 80)
    print(f"Found {len(found_files)} donation log file(s) in {len(set(f.parent for f, _ in found_files))} directory/ies:")
    print("=" * 80)
    
    # Group by directory
    by_directory = defaultdict(lambda: {'files': [], 'location_type': None, 'total_size': 0})
    for file_path, location_type in found_files:
        directory = file_path.parent
        by_directory[directory]['files'].append(file_path)
        if by_directory[directory]['location_type'] is None:
            by_directory[directory]['location_type'] = location_type
        # Calculate total size
        try:
            size = file_path.stat().st_size
            by_directory[directory]['total_size'] += size
        except OSError:
            pass
    
    # Sort directories by file count (descending)
    sorted_dirs = sorted(
        by_directory.items(),
        key=lambda x: (len(x[1]['files']), x[1]['total_size']),
        reverse=True
    )
    
    for directory, info in sorted_dirs:
        file_count = len(info['files'])
        total_size = info['total_size']
        location_type = info['location_type']
        
        # Count file types
        donation_files = sum(1 for f in info['files'] if 'donation-' in f.name)
        consolidation_files = sum(1 for f in info['files'] if 'consolidations.jsonl' in f.name)
        
        size_str = f"{total_size:,} bytes" if total_size < 1024*1024 else f"{total_size/(1024*1024):.2f} MB"
        
        print(f"\n{directory}")
        print(f"  Location type: {location_type}")
        print(f"  Files found: {file_count}")
        if donation_files > 0:
            print(f"    - Donation logs: {donation_files}")
        if consolidation_files > 0:
            print(f"    - Consolidation logs: {consolidation_files}")
        print(f"  Total size: {size_str}")
    
    print("\n" + "=" * 80)
    print("Summary:")
    print(f"  Total directories: {len(by_directory)}")
    print(f"  Total files found: {len(found_files)}")
    print(f"  Donation log files (donation-*.jsonl): {sum(1 for f, _ in found_files if 'donation-' in str(f))}")
    print(f"  Consolidation files (consolidations.jsonl): {sum(1 for f, _ in found_files if 'consolidations.jsonl' in str(f))}")
    print("=" * 80)


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
    # On Windows, use USERPROFILE; on Unix, use HOME
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
    
    # On Windows, also check if Documents folder might be in a different location
    # Some Windows setups might have Documents in a different path
    if sys.platform == 'win32':
        # Check if USERPROFILE is set and different from Path.home()
        userprofile = os.environ.get('USERPROFILE')
        if userprofile and userprofile != str(home):
            alt_documents = Path(userprofile) / 'Documents'
            alt_storage = alt_documents / 'MidnightFetcherBot' / 'storage'
            alt_donations = alt_storage / 'donations'
            if alt_donations.exists():
                return alt_storage, alt_donations
    
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
    parser.add_argument(
        '--search',
        '-s',
        action='store_true',
        help='Search for donation log files across the system'
    )
    parser.add_argument(
        '--search-all',
        action='store_true',
        help='Search entire system for donation files (slower but more thorough)'
    )
    parser.add_argument(
        '--search-depth',
        type=int,
        default=10,
        help='Maximum directory depth when searching (default: 10)'
    )
    
    args = parser.parse_args()
    
    # Handle search mode
    if args.search or args.search_all:
        found_files = search_for_donation_files(
            search_entire_system=args.search_all,
            max_depth=args.search_depth
        )
        print_search_results(found_files)
        
        # Optionally, if files were found, ask if user wants to summarize them
        if found_files:
            print("\nTo summarize donations from these files, you can:")
            print("  1. Use --directory to specify a specific donations folder")
            print("  2. The script will automatically use the first found location")
            print("\nExample:")
            donation_dirs = {f.parent for f, _ in found_files if 'donation-' in str(f)}
            if donation_dirs:
                print(f"  python3 scripts/summarize_donations.py -d \"{list(donation_dirs)[0]}\"")
        sys.exit(0)
    
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
            print("\nChecked locations:", file=sys.stderr)
            print(f"  1. {Path.cwd() / 'storage' / 'donations'}", file=sys.stderr)
            print(f"  2. {Path.home() / 'Documents' / 'MidnightFetcherBot' / 'storage' / 'donations'}", file=sys.stderr)
            print(f"  3. {Path.cwd() / 'Documents' / 'MidnightFetcherBot' / 'storage' / 'donations'}", file=sys.stderr)
            if sys.platform == 'win32':
                userprofile = os.environ.get('USERPROFILE')
                if userprofile:
                    print(f"  4. {Path(userprofile) / 'Documents' / 'MidnightFetcherBot' / 'storage' / 'donations'}", file=sys.stderr)
            print("\nPossible reasons:", file=sys.stderr)
            print("  - Donation logger failed to create directories (check console logs for errors)", file=sys.stderr)
            print("  - Windows path length limit exceeded (260 characters)", file=sys.stderr)
            print("  - Permission issues preventing directory creation", file=sys.stderr)
            print("  - Antivirus blocking file creation", file=sys.stderr)
            print("\nTo debug:", file=sys.stderr)
            print("  - Check server console logs for '[Donation] Failed to write donation log' errors", file=sys.stderr)
            print("  - Verify folder permissions on Documents directory", file=sys.stderr)
            print("  - Check if antivirus is blocking file writes", file=sys.stderr)
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

