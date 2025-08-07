// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 5000;

app.use(bodyParser.json());

// Configuration from environment variables
const META_API_TOKEN = process.env.META_API_TOKEN;
const ACCOUNT_ID = process.env.ACCOUNT_ID;
const DEFAULT_SYMBOL = process.env.DEFAULT_SYMBOL || 'XAUUSD';
const RISK_PERCENT_LIMIT = 5; // Max risk percentage

// Validate environment variables
if (!META_API_TOKEN || !ACCOUNT_ID) {
    console.error('Missing required environment variables');
    process.exit(1);
}

// MetaAPI Service Abstraction
const metaApiService = {
    async getAccountData() {
        const response = await axios.get(
            `https://api.metaapi.cloud/v1/trading/accounts/${ACCOUNT_ID}/account`,
            { headers: { 'Authorization': `Bearer ${META_API_TOKEN}` } }
        );
        return response.data;
    },

    async getPositions() {
        const response = await axios.get(
            `https://api.metaapi.cloud/v1/trading/accounts/${ACCOUNT_ID}/positions`,
            { headers: { 'Authorization': `Bearer ${META_API_TOKEN}` } }
        );
        return response.data;
    },

    async closePosition(positionId) {
        await axios.delete(
            `https://api.metaapi.cloud/v1/trading/accounts/${ACCOUNT_ID}/positions/${positionId}`,
            { headers: { 'Authorization': `Bearer ${META_API_TOKEN}` } }
        );
    },

    async getSymbolQuote(symbol) {
        const response = await axios.get(
            `https://api.metaapi.cloud/v1/market/symbols/${symbol}/quote`,
            { headers: { 'Authorization': `Bearer ${META_API_TOKEN}` } }
        );
        return response.data;
    },

    async createOrder(orderData) {
        const response = await axios.post(
            `https://api.metaapi.cloud/v1/trading/accounts/${ACCOUNT_ID}/orders`,
            orderData,
            { headers: { 
                'Authorization': `Bearer ${META_API_TOKEN}`,
                'Content-Type': 'application/json'
            }}
        );
        return response.data;
    }
};

// Trading Utilities
const tradingUtils = {
    calculateLotSize(accountBalance, riskPercent, stopLossPips, symbol) {
        if (riskPercent > RISK_PERCENT_LIMIT) {
            throw new Error(`Risk exceeds ${RISK_PERCENT_LIMIT}% limit`);
        }
        
        const pipValues = {
            'XAUUSD': 1,    // $1 per pip per standard lot
            'EURUSD': 10,   // $10 per pip per standard lot
            'GBPUSD': 10,
            'USDJPY': 9.1   // Currency-specific values
        };
        
        const pipValuePerLot = pipValues[symbol] || 10;
        const riskAmount = accountBalance * (riskPercent / 100);
        const lotSize = riskAmount / (stopLossPips * pipValuePerLot);
        
        return parseFloat(lotSize.toFixed(2));
    },

    calculateStopLossPrice(direction, currentPrice, stopLossPips) {
        const pipAdjustment = stopLossPips * 0.01;
        return direction === 'BUY' 
            ? (currentPrice - pipAdjustment).toFixed(2)
            : (currentPrice + pipAdjustment).toFixed(2);
    }
};

// Error Handling Middleware
app.use((err, req, res, next) => {
    console.error(`Server Error: ${err.message}`);
    res.status(500).json({
        success: false,
        message: err.message || 'Internal server error'
    });
});

// API Endpoints
app.get('/api/balance', async (req, res, next) => {
    try {
        const accountData = await metaApiService.getAccountData();
        res.json({
            success: true,
            balance: accountData.balance,
            equity: accountData.equity
        });
    } catch (error) {
        next(new Error(`Balance check failed: ${error.message}`));
    }
});

app.get('/api/positions', async (req, res, next) => {
    try {
        const positions = await metaApiService.getPositions();
        const symbolFilter = req.query.symbol || DEFAULT_SYMBOL;
        res.json({
            success: true,
            positions: positions.filter(p => p.symbol === symbolFilter)
        });
    } catch (error) {
        next(new Error(`Position fetch failed: ${error.message}`));
    }
});

app.post('/api/close-position', async (req, res, next) => {
    try {
        const { positionId } = req.body;
        if (!positionId) {
            return res.status(400).json({
                success: false,
                message: 'Position ID required'
            });
        }

        await metaApiService.closePosition(positionId);
        res.json({ success: true, message: 'Position closed' });
    } catch (error) {
        next(new Error(`Close position failed: ${error.message}`));
    }
});

app.post('/api/trade', async (req, res, next) => {
    try {
        const { direction, symbol = DEFAULT_SYMBOL, lotSize, riskPercent, stopLossPips } = req.body;
        
        // Input validation
        if (!['BUY', 'SELL'].includes(direction)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid direction (use BUY/SELL)'
            });
        }

        if (!lotSize && (!riskPercent || !stopLossPips)) {
            return res.status(400).json({
                success: false,
                message: 'Provide either lotSize or riskPercent+stopLossPips'
            });
        }

        let finalLotSize = lotSize;
        let stopLossPrice = null;

        // Dynamic lot calculation
        if (!lotSize && riskPercent && stopLossPips) {
            const accountData = await metaApiService.getAccountData();
            finalLotSize = tradingUtils.calculateLotSize(
                accountData.balance,
                riskPercent,
                stopLossPips,
                symbol
            );
        }

        // Stop loss calculation
        if (stopLossPips) {
            const quote = await metaApiService.getSymbolQuote(symbol);
            const pricePoint = direction === 'BUY' ? quote.ask : quote.bid;
            stopLossPrice = tradingUtils.calculateStopLossPrice(
                direction,
                pricePoint,
                stopLossPips
            );
        }

        // Prepare order
        const orderData = {
            symbol,
            volume: finalLotSize,
            type: direction === 'BUY' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL',
            ...(stopLossPrice && { stopLoss: stopLossPrice }),
            magic: Math.floor(Math.random() * 1000000),
            comment: `Risk: ${riskPercent || 'Fixed'}%`
        };

        // Execute trade
        const orderResult = await metaApiService.createOrder(orderData);
        
        res.json({
            success: true,
            message: 'Trade executed',
            orderId: orderResult.id,
            symbol,
            direction,
            lotSize: finalLotSize,
            stopLoss: stopLossPrice
        });

    } catch (error) {
        next(new Error(`Trade failed: ${error.message}`));
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Trading symbol: ${DEFAULT_SYMBOL}`);
});
