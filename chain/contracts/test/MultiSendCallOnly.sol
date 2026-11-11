// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity >=0.7.0 <0.9.0;

/// Safe's MultiSendCallOnly (v1.4.1), for local tests only: on Amoy and Polygon the server uses
/// Safe's own deployment. Batches calls (operation 0) made from the Safe in one transaction; any
/// failure reverts the whole batch. Delegate calls (operation 1) are refused.
contract MultiSendCallOnly {
    function multiSend(bytes memory transactions) public payable {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            let length := mload(transactions)
            let i := 0x20
            for {
                // Pre block is not used in "while mode"
            } lt(i, length) {
                // Post block is not used in "while mode"
            } {
                // First byte of the data is the operation.
                let operation := shr(0xf8, mload(add(transactions, i)))
                // The next 20 bytes are the address.
                let to := shr(0x60, mload(add(transactions, add(i, 0x01))))
                // Defaults `to` to `address(this)` if `address(0)` is provided.
                to := or(to, mul(iszero(to), address()))
                // The next 32 bytes are the value.
                let value := mload(add(transactions, add(i, 0x15)))
                // The next 32 bytes are the data length.
                let dataLength := mload(add(transactions, add(i, 0x35)))
                // The rest is the data.
                let data := add(transactions, add(i, 0x55))
                let success := 0
                switch operation
                case 0 {
                    success := call(gas(), to, value, data, dataLength, 0, 0)
                }
                // This version does not allow delegatecalls
                case 1 {
                    revert(0, 0)
                }
                if eq(success, 0) {
                    let errorLength := returndatasize()
                    returndatacopy(0, 0, errorLength)
                    revert(0, errorLength)
                }
                // Next entry starts at 85 byte + data length
                i := add(i, add(0x55, dataLength))
            }
        }
    }
}
