import os
import logging

from typing import List, Dict, Optional, Iterator
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from multiprocessing import Pool, cpu_count

from dotenv import load_dotenv
from pymongo import MongoClient, UpdateOne
from pymongo.errors import ConnectionFailure
from bson.objectid import ObjectId

load_dotenv(dotenv_path="/home/ubuntu/failed-addresses/.env")

logging.basicConfig(
    format="%(asctime)s - %(levelname)s - %(message)s",
    level=logging.INFO
)
logger = logging.getLogger(__name__)


@dataclass
class MongoConfig:
    """Configuration for MongoDB connection"""
    url: str
    db_name: str
    failed_tx_collection: str
    batch_size: int = 1000
    max_pool_size: int = 100
    timeout_ms: int = 30000
    processes: int = cpu_count() - 1


class Mongo:

    def __init__(self) -> None:
        self.config = MongoConfig(
            url=os.environ.get("MONGODB_URI"),
            db_name=os.environ.get("DB_NAME"),
            failed_tx_collection=os.environ.get("FAILED_TX_COLLECTION")
        )
        self.client = self._create_client()
        self.db = os.environ.get("DB_NAME")
        self.failed_collection = os.environ.get("FAILED_TX_COLLECTION")
        self.bots_collection = os.environ.get("BOTS_COLLECTION")

    def _create_client(self) -> Optional[MongoClient]:
        """Create MongoDB client with optimized connection settings"""
        try:
            return MongoClient(
                self.config.url,
                maxPoolSize=self.config.max_pool_size,
                serverSelectionTimeoutMS=self.config.timeout_ms,
                connect=True,
                ssl=True
            )
        except ConnectionFailure as e:
            logger.error(f"Failed to create MongoDB client: {e}")
            return None

    def _get_chunks(self) -> Iterator[List[Dict]]:
        """Split failed bots into chunks for parallel processing"""

        current_chunk = []
        collection = self.client[self.db][self.failed_collection]
        cursor = collection.find(
            {"status": False},
            {"_id": 1, "address": 1, "botId": 1}
        ).batch_size(self.config.batch_size)

        for bot in cursor:
            current_chunk.append(bot)
            if len(current_chunk) >= self.config.batch_size:
                yield current_chunk
                current_chunk = []
        
        if current_chunk:
            yield current_chunk

    @staticmethod
    def process_chunk(chunk: List[Dict]) -> None:
        """Process a single chunk of bots (used for parallerl processing)"""
        # Create new instance for each process
        mongo = Mongo()
        mongo._process_bot_batch(chunk)

    def fetch_failed_bots(self, use_paraller: bool = True) -> None:
        """Fetch and process failed bots using either parallel or sequential processing"""
        try:
            # Paraller processing
            if use_paraller:
                chunks = list(self._get_chunks())
                logger.info(f"Starting parallel processing with {self.config.processes} processes")
                with Pool(processes=self.config.processes) as pool:
                    pool.map(self.process_chunk, chunks)
            else:
                # Sequential processing
                logger.info("Starting sequential processing")
                for chunk in self._get_chunks():
                    self._process_bot_batch(chunk)

        except Exception as exc:
            logger.error(f"Failed to process bots: {exc}")
        finally:
            if self.client: self.client.close()

    @lru_cache(maxsize=1000)
    def _get_bot_data(self, bot_id: str) -> Optional[Dict]:
        """Cache and retrieve bot data"""
        try:
            collection = self.client[self.db][self.bots_collection]
            return collection.find_one({"_id": ObjectId(bot_id)})
        except Exception as exc:
            logger.error(f"Error fetching bot data for {bot_id}: {exc}")
            return None

    def _process_bot_batch(self, batch: List[Dict]) -> None:
        """Process a batch of bots with bulk operations"""
        if not batch: return

        bulk_updates = []

        for num, failed_bot in enumerate(batch):
            bot = self._get_bot_data(str(failed_bot["botId"]))

            if bot and any(
                key.startswith("sAddress") and value == failed_bot["address"]
                for key, value in bot.items()
            ):
                bulk_updates.append(
                    UpdateOne(
                        {"_id": failed_bot["_id"]},
                        {"$set": {"status": True, "updatedAt": datetime.utcnow()}}
                    )
                )

        if bulk_updates:
            try:
                collection = self.client[self.db][self.failed_collection]
                collection.bulk_write(bulk_updates, ordered=False)
                logger.info(f"Processed {num} bots in batch")
            except Exception as exc:
                logger.error(f"Bulk update failed: {exc}")
        return bulk_updates


if __name__ == "__main__":
    mongo = Mongo()
    mongo.fetch_failed_bots(use_paraller=True)
